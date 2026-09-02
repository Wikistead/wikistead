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
// Two more refusals review c-af763a4 (3rd pass) found and reproduced live, neither named by
// the ADR (both are correctness gaps this implementation must not have, not new Acceptance lines):
//   - an invalid --keep id: without this check, a single mistyped space id silently computes an EMPTY
//     doomed-exclusion for that id — computeDoomedIds's `<> ALL(keepSpaceIds)` matches every space
//     when the id names nothing — so the space the operator meant to protect (the ENTIRE reason §1
//     ships before §2: a demo's Hacker News URL is a kept space's share link) is swept anyway, while
//     the output still reports it as "kept". Validated by existence before any write.
//   - an unfinished prior sweep for this tenant, now RESUMED rather than merely refused — see the 4th
//     pass note below.
//
// ⚠️ review c-af763a4's 4th pass bounced the 3rd pass's fix for the unfinished-sweep case:
// refusing outright left no way to actually FINISH an interrupted sweep (ADR-252 Acceptance: "a re-run
// finishes it"), and reproduced two sharper problems live against the real dev stack:
//   - a race, not just a stale-report: two concurrent `resetTenant` calls for the same tenant both pass
//     the unfinished-sweep check (a plain SELECT with no lock), both write their own manifest, and BOTH
//     run — a `--keep` call racing a no-`--keep` call swept the kept space's row while still reporting
//     it as kept. Fixed with a per-tenant `pg_advisory_xact_lock` (the same shape
//     `operator-ledger.ts`'s `OPERATOR_CHAIN_LOCK` and `transparency.ts`'s `projectionLockKey` already
//     use) held for the ENTIRE decide-then-write section below, so a second concurrent call blocks
//     until the first's decision is durably committed, then sees it.
//   - a manifest whose progress row never got written (a crash between the two INSERTs write-manifest.ts
//     used to issue) was invisible to an INNER JOIN unfinished-check — D1 quietly stopped protecting
//     anything the moment its own precondition failed. write-manifest.ts's insert is now one atomic
//     statement (see that file); this file's own check is also widened to a LEFT JOIN treating "manifest
//     exists with no progress row at all" as unfinished too, so the two fixes don't depend on each other
//     to both hold.
//
// ⚠️ review c-af763a4's 5th pass bounced the 4th pass's fix twice more:
//   - the 4th pass's own break-check for the lock (`Promise.allSettled` racing two real `resetTenant`
//     calls) turned out to be timing-dependent — measured to pass 3-of-4 runs even with the lock line
//     deleted outright, a pin in appearance only. Replaced with a deterministic test that holds
//     `tenantResetLockKey`'s own advisory lock on a separate connection and asserts `resetTenant`
//     genuinely blocks on it, not merely "usually finishes in the right order".
//   - the --keep existence check (D2/3rd pass) ran BEFORE the lock and unconditionally, on every call
//     — including a resume. Reproduced live: a kept space's row deleted by any other means between the
//     database step committing and a resume attempt made `--keep=X` refuse (existence check fails) AND
//     no `--keep` refuse (keep-list mismatch against the recorded manifest) — no input could ever
//     finish that sweep, orphaning its FGA tuples and S3 keys the same way F1's original bug did. Moved
//     inside the transaction, into ONLY the "no unfinished manifest — write a new one" branch: a resume
//     trusts the manifest's own already-durable keep-list instead of re-validating it against live rows
//     that may have moved on since it was written.
import { createHash } from 'node:crypto'
import os from 'node:os'
import postgres from 'postgres'
import { fgaClient } from '@wikistead/authz'
import { LogicalSearchDriver } from '../search/index.js'
import { LogicalStorageDriver } from '../storage/index.js'
import { appendOperatorEntry } from '../audit/operator-ledger.js'
import { writeResetManifest } from '../tenant-sweep/write-manifest.js'
import { runResetSweep } from '../tenant-sweep/run-sweep.js'
import { reconstructDoomedIds } from '../tenant-sweep/manifest-fga.js'

// Namespaced away from OPERATOR_CHAIN_LOCK (179179) and transparency.ts's projectionLockKey
// (435_000_000+) by a distinct prefix — same hash-derived-int shape, different keyspace, so this
// lock's contention is scoped to concurrent resets of the SAME tenant and never collides with either
// of those unrelated locks.
// Exported so a test can hold this exact lock on a separate connection and assert `resetTenant`
// genuinely blocks on it (review c-af763a4, 5th pass, G1) — a `Promise.allSettled` race
// between two real `resetTenant` calls is timing-dependent and was measured to pass 3-of-4 runs even
// with the lock deliberately removed, making it a pin in appearance only.
export function tenantResetLockKey(tenantId: string): number {
  return 810_000_000 + (parseInt(createHash('sha256').update(tenantId).digest('hex').slice(0, 6), 16) % 1_000_000)
}

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

  // `reason: 'maintenance'` — operator-ledger.ts's own doc comment says this field is "a FIXED enum
  // code... never free text" (ADR-169; packages/ee-server/src/audit/transparency.ts's
  // TRANSPARENCY_REASONS normalizes anything else to 'unspecified') — an earlier draft of this file
  // put descriptive detail (keep-list, manifest id) here, which is not what the field is for; that
  // detail lives in the manifest row itself. 'maintenance' matches the category
  // migrate-comment-independence-553.ts and converge-role-duplicates-536.ts already use for the same
  // shape of operator action — verified by grep, not guessed (login-methods.ts's own 'recovery' is
  // NOT in TRANSPARENCY_REASONS and silently normalizes to 'unspecified', a pre-existing bug in that
  // file, not a precedent to copy).
  //
  // Everything from the advisory lock through either writing a NEW manifest or resuming an existing
  // one runs in ONE transaction: the lock's whole job is making the "does an unfinished sweep already
  // exist" answer and the resulting write happen as one atomic step, so a second concurrent call for
  // the same tenant blocks on the lock rather than reading the same "no" both calls started with (the
  // race review c-af763a4's 4th pass reproduced live — see the file-header note).
  const at = new Date().toISOString()
  const { manifestId, doomed } = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${tenantResetLockKey(tenant.id)})`

    // LEFT JOIN, not the 3rd pass's INNER JOIN: a manifest whose progress row never got written (e.g.
    // a crash between two INSERTs — no longer possible after write-manifest.ts's fix, but a defence
    // that depends on only one of two independent fixes holding is not a defence) must still count as
    // unfinished, not vanish from this query entirely.
    const [unfinished] = await tx<{ id: string; keep_space_ids: string[]; fga_object_ids: string[] }[]>`
      SELECT m.id, m.keep_space_ids, m.fga_object_ids
      FROM tenant_sweep_manifests m
      LEFT JOIN tenant_sweep_progress p ON p.manifest_id = m.id
      WHERE m.tenant_id = ${tenant.id} AND m.operation = 'reset'
        AND (p.manifest_id IS NULL OR NOT (p.database_done AND p.fga_done AND p.search_done AND p.storage_done))
      LIMIT 1`

    if (unfinished) {
      // A resume trusts the manifest's OWN recorded keep-list, not whatever --keep this invocation
      // passed — the manifest is the durable decision; this invocation's job is to finish it, not to
      // silently redefine it partway through (which would run part of the sweep against one keep-list
      // and the rest against another). A mismatch refuses rather than picking either one silently.
      const recorded = new Set(unfinished.keep_space_ids)
      const requested = new Set(keepSpaceIds)
      const mismatch = recorded.size !== requested.size || [...recorded].some((id) => !requested.has(id))
      if (mismatch) {
        throw Object.assign(
          new Error(`tenant "${args.slug}" has an unfinished reset (manifest ${unfinished.id}) started with --keep=${unfinished.keep_space_ids.join(',') || '(none)'} — pass the same --keep to resume it (a mismatched --keep is refused rather than silently switched mid-sweep), or investigate manifest ${unfinished.id} manually`),
          { code: 'unfinished_sweep_keep_mismatch' },
        )
      }
      // `ON CONFLICT DO NOTHING`: covers the (now believed unreachable, after write-manifest.ts's fix)
      // case of a manifest with no progress row at all — resuming still needs one to update.
      await tx`INSERT INTO tenant_sweep_progress (manifest_id) VALUES (${unfinished.id}) ON CONFLICT (manifest_id) DO NOTHING`
      await appendOperatorEntry(tx, { actor: `operator:${args.operator}`, action: 'tenant.reset_resumed', target: `tenant:${tenant.id}`, at, reason: 'maintenance' })
      return { manifestId: unfinished.id, doomed: reconstructDoomedIds(unfinished.fga_object_ids) }
    }

    // review c-af763a4 (3rd pass, D2 / 5th pass, G2): without this check, a mistyped --keep
    // id computes an EMPTY exclusion for it (computeDoomedIds's `id <> ALL(keepSpaceIds)` matches
    // every real space when the given id names nothing), so the space the operator meant to protect is
    // swept anyway — while the output still reports it as kept. Deliberately scoped to THIS branch
    // only (not the resume branch above, and not run before the lock/unfinished-check the way the 3rd
    // pass had it): the 5th pass reproduced live that validating existence unconditionally could
    // permanently strand a tenant — a kept space's row gone by the time of a resume attempt (the
    // reset's own database step may have already run) made BOTH `--keep=X` (existence check fails) and
    // no `--keep` (keep-list mismatch against the recorded manifest) refuse forever, with no way to
    // finish the interrupted sweep at all. A resume trusts the manifest's own already-durable decision
    // instead of re-validating it against live rows that may have moved on.
    if (keepSpaceIds.length > 0) {
      const found = await tx<{ id: string }[]>`SELECT id FROM spaces WHERE tenant_id = ${tenant.id} AND id = ANY(${[...keepSpaceIds]})`
      const foundIds = new Set(found.map((r) => r.id))
      const invalid = keepSpaceIds.filter((id) => !foundIds.has(id))
      if (invalid.length > 0) {
        throw Object.assign(
          new Error(`--keep names ${invalid.length} id(s) that are not a space in "${args.slug}": ${invalid.join(', ')} — refusing rather than silently sweeping what you meant to protect`),
          { code: 'invalid_keep_id' },
        )
      }
    }

    const written = await writeResetManifest(tx, tenant.id, keepSpaceIds)
    await appendOperatorEntry(tx, { actor: `operator:${args.operator}`, action: 'tenant.reset_started', target: `tenant:${tenant.id}`, at, reason: 'maintenance' })
    return written
  })

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
    keptSpaceCount: new Set(keepSpaceIds).size,
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
