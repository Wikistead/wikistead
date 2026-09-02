// tenant:reset — ADR-252 §1 / #810: empties a workspace but keeps the tenant row, its slug, its
// members, its login configuration. Ships first (the honest, smaller half of "remove a tenant"):
// removal (§2, three phases, a grace period) is not built.
//
//   pnpm tenant:reset <tenantSlug> --confirm=<tenantSlug> [--keep=<spaceId>,<spaceId>,...] [--by=<operator>]
//
// OPERATOR action, same shape as tenant:login-methods: admin DB credentials, bypasses RLS, no HTTP
// surface, recorded in the operator ledger (ADR-089) because an unrecorded privileged destructive
// write must be impossible. The workspace's own settings screen is ADR-252's PRIMARY surface for this
// ("Two surfaces, one for each audience... neither is the operator console"); this CLI is the
// operator's, for a workspace whose screen cannot be reached — so the "caller is tenant#admin" refusal
// ADR-252's Acceptance names is the HTTP route's job, not this one's; an operator running this command
// already bypasses tenant-side authorization by design, the same way break-glass does everywhere else
// in this file's siblings.
//
// Refusals (ADR-252 Acceptance: "wrong confirmation, a caller who is not tenant#admin, unknown slug,
// namespace-isolated tenant" — the middle one is the HTTP route's, the other three are this command's):
//   - unknown slug: no tenant with that slug
//   - wrong confirmation: --confirm does not match the slug being reset, byte for byte
//   - namespace-isolated tenant: every query this sweep issues (derive.ts onward) assumes the tenant's
//     rows live in the shared logical-isolation tables — for isolation='namespace' they do not (that
//     tenant's rows are physically elsewhere), so running this sweep against one would silently sweep
//     nothing while reporting success. Refused, not attempted; namespace-isolated reset is unbuilt.
//
// Two more refusals review c-af763a4 found and reproduced live, neither named by the ADR
// (both are correctness gaps this implementation must not have, not new Acceptance lines):
//   - an unfinished prior sweep for this tenant: writeResetManifest always creates a NEW manifest, and
//     computeDoomedIds re-derives its id sets from whatever rows are STILL LIVE. If a prior run's
//     database step committed and then the process died before fga/search/storage ran, a second
//     invocation would compute an EMPTY doomed set (the rows are already gone), report
//     "0 page(s) emptied" — reading as "already clean" — and leave the first manifest's S3 keys and
//     FGA tuples permanently unreachable (nothing ever reads a manifest this command didn't just
//     create). Refusing to start a second sweep while an unfinished one exists is the cheap, safe
//     fix; teaching this command to RESUME an old manifest (reconstructible in principle — its
//     fga_object_ids already encode the doomed id sets, see manifest-fga.ts) is future work, not
//     invented here under review pressure.
//   - an invalid --keep id: without this check, a single mistyped space id silently computes an EMPTY
//     doomed-exclusion for that id — computeDoomedIds's `<> ALL(keepSpaceIds)` matches every space
//     when the id names nothing — so the space the operator meant to protect (the ENTIRE reason §1
//     ships before §2: a demo's Hacker News URL is a kept space's share link) is swept anyway, while
//     the output still reports it as "kept". Validated by existence before any write.
import os from 'node:os'
import postgres from 'postgres'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { appendOperatorEntry } from '../audit/operator-ledger.js'
import { writeResetManifest } from '../tenant-sweep/write-manifest.js'
import { runResetSweep } from '../tenant-sweep/run-sweep.js'

export interface TenantResetResult {
  manifestId: string
  /** The count of --keep ids, each independently verified (before any write) to name a real space in
   * this tenant — never merely "the count requested" (review c-af763a4, D2/D5: an unverified
   * count would have reported a typo'd, actually-swept space as "kept"). */
  keptSpaceCount: number
  doomedSpaceCount: number
  sweptPageCount: number
  /** Always false today — §6b (sessions) is proposed, not built, so "every store verified" (the
   * condition ADR-252 ties manifest deletion to) can never be true yet. Printed rather than hidden:
   * an operator running this command should see, in the output, that a manual sessions check (or a
   * later re-run once §6b lands) is still owed. */
  fullyComplete: false
}

export async function resetTenant(
  sql: postgres.Sql,
  args: { slug: string; confirm: string; keepSlugsOrIds?: readonly string[]; operator: string },
): Promise<TenantResetResult> {
  if (args.confirm !== args.slug) {
    throw Object.assign(new Error(`confirmation "${args.confirm}" does not match "${args.slug}" — refusing`), { code: 'wrong_confirmation' })
  }
  const [tenant] = await sql<{ id: string; isolation: string }[]>`SELECT id, isolation FROM tenants WHERE slug = ${args.slug}`
  if (!tenant) throw Object.assign(new Error(`no tenant with slug "${args.slug}"`), { code: 'tenant_not_found' })
  if (tenant.isolation !== 'logical') {
    throw Object.assign(
      new Error(`tenant "${args.slug}" is namespace-isolated (isolation='${tenant.isolation}') — tenant:reset only knows how to sweep logical-isolation tenants; refusing rather than silently sweeping nothing`),
      { code: 'namespace_isolated' },
    )
  }
  const keepSpaceIds = args.keepSlugsOrIds ?? []

  // review c-af763a4 (D2, reproduced live): without this check, a mistyped --keep id
  // computes an EMPTY exclusion for it (computeDoomedIds's `id <> ALL(keepSpaceIds)` matches every
  // real space when the given id names nothing), so the space the operator meant to protect is swept
  // anyway — while the output still reports it as kept. A keep-list is a decision an operator makes,
  // not a shape the code guesses at (ADR-252 §1's own words); validated against real existence, in
  // this tenant, before any write, not trusted.
  if (keepSpaceIds.length > 0) {
    const found = await sql<{ id: string }[]>`SELECT id FROM spaces WHERE tenant_id = ${tenant.id} AND id = ANY(${[...keepSpaceIds]})`
    const foundIds = new Set(found.map((r) => r.id))
    const invalid = keepSpaceIds.filter((id) => !foundIds.has(id))
    if (invalid.length > 0) {
      throw Object.assign(
        new Error(`--keep names ${invalid.length} id(s) that are not a space in "${args.slug}": ${invalid.join(', ')} — refusing rather than silently sweeping what you meant to protect`),
        { code: 'invalid_keep_id' },
      )
    }
  }

  // review c-af763a4 (D1, reproduced live): writeResetManifest always creates a NEW
  // manifest, and computeDoomedIds re-derives its id sets from whatever rows are STILL LIVE — so if a
  // prior run's database step committed and then the process died before fga/search/storage ran, a
  // second invocation would compute an EMPTY doomed set (the rows are already gone), report
  // "0 page(s) emptied" (reading as "already clean"), and leave that first manifest's S3 keys and FGA
  // tuples permanently unreachable — nothing ever reads a manifest this command didn't just create.
  // Refusing to start a second sweep while an unfinished one exists is the cheap, safe fix; teaching
  // this command to RESUME an old manifest is future work, not invented here under review pressure.
  const [unfinished] = await sql<{ id: string }[]>`
    SELECT m.id FROM tenant_sweep_manifests m
    JOIN tenant_sweep_progress p ON p.manifest_id = m.id
    WHERE m.tenant_id = ${tenant.id} AND m.operation = 'reset'
      AND NOT (p.database_done AND p.fga_done AND p.search_done AND p.storage_done)
    LIMIT 1`
  if (unfinished) {
    throw Object.assign(
      new Error(`tenant "${args.slug}" already has an unfinished reset (manifest ${unfinished.id}) — refusing to start a second sweep, which would compute an empty doomed set from the rows the first sweep already touched and leave its storage/FGA cleanup unreachable. Investigate manifest ${unfinished.id} and tenant_sweep_progress manually.`),
      { code: 'unfinished_sweep_exists' },
    )
  }

  const { manifestId, doomed } = await writeResetManifest(sql, tenant.id, keepSpaceIds)
  const at = new Date().toISOString()
  // `reason: 'maintenance'` — operator-ledger.ts's own doc comment says this field is "a FIXED enum
  // code... never free text" (ADR-169; packages/ee-server/src/audit/transparency.ts's
  // TRANSPARENCY_REASONS normalizes anything else to 'unspecified') — an earlier draft of this file
  // put descriptive detail (keep-list, manifest id) here, which is not what the field is for; that
  // detail lives in the manifest row itself. 'maintenance' matches the category
  // migrate-comment-independence-553.ts and converge-role-duplicates-536.ts already use for the same
  // shape of operator action — verified by grep, not guessed (login-methods.ts's own 'recovery' is
  // NOT in TRANSPARENCY_REASONS and silently normalizes to 'unspecified', a pre-existing bug in that
  // file, not a precedent to copy).
  await sql.begin((tx) => appendOperatorEntry(tx, {
    actor: `operator:${args.operator}`,
    action: 'tenant.reset_started',
    target: `tenant:${tenant.id}`,
    at,
    reason: 'maintenance',
  }))

  await runResetSweep(sql, { fga: fgaClient, search: new LogicalSearchDriver(), storage: new LogicalStorageDriver() }, manifestId, tenant.id, doomed)

  await sql.begin((tx) => appendOperatorEntry(tx, {
    actor: `operator:${args.operator}`,
    action: 'tenant.reset_swept',
    target: `tenant:${tenant.id}`,
    at: new Date().toISOString(),
    reason: 'maintenance',
  }))

  return {
    manifestId,
    keptSpaceCount: keepSpaceIds.length,
    doomedSpaceCount: doomed.spaceIds.length,
    sweptPageCount: doomed.pageIds.length,
    fullyComplete: false,
  }
}

export function renderResult(r: TenantResetResult): string {
  const lines = [
    `swept ${r.doomedSpaceCount} space(s) entirely, ${r.keptSpaceCount} space(s) kept (their rows/settings/share links survive, their pages were emptied like everyone else's)`,
    `${r.sweptPageCount} page(s) emptied across database/FGA/search/storage`,
    `manifest ${r.manifestId} is STILL PRESENT — this is correct, not a bug: sessions (ADR-252 §6b) is proposed but not built, so "every store verified" is never true yet.`,
    'a live editor session open on a swept page before this ran may still be able to write for the rest of its connection lifetime (best-effort close is not implemented); a NEW connection or reconnect is rejected regardless (the FGA step already ran).',
  ]
  return lines.join('\n')
}

export async function cliMain(argv: string[] = process.argv): Promise<void> {
  const slug = argv[2]
  if (!slug || slug.startsWith('--')) {
    console.error('usage: pnpm tenant:reset <tenantSlug> --confirm=<tenantSlug> [--keep=<spaceId>,<spaceId>,...] [--by=<operator>]')
    process.exit(2)
  }
  const opt = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
  const confirm = opt('confirm')
  if (!confirm) {
    console.error('--confirm=<tenantSlug> is required — type the slug being reset, exactly')
    process.exit(2)
  }
  const keepRaw = opt('keep')
  const keepSlugsOrIds = keepRaw ? keepRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
  const operator = opt('by') || process.env.WIKISTEAD_OPERATOR || os.userInfo().username || 'unknown'
  const adminPool = postgres(process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!)
  try {
    const result = await resetTenant(adminPool, { slug, confirm, keepSlugsOrIds, operator })
    console.log(renderResult(result))
  } catch (err) {
    console.error(`tenant:reset: ${(err as Error).message}`)
    process.exit(1)
  } finally {
    await adminPool.end()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void cliMain()
}
