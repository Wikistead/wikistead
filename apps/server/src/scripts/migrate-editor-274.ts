// #274 / ADR-135 §1a-1b migration: the space `editor` SPLIT. The final model (model.fga) moves the
// member/group types off `editor` onto the new `editor_member` leaf (viewer_member/template#view
// reference the leaf; `editor` carries only space edit share-links). On a PERSISTENT store the flip
// must be TWO-STEP or existing `space:S#editor@user:U` tuples go type-invalid and members silently
// lose edit (the #100 write-ripple class):
//
//   Step A  write the TRANSITIONAL model (derived from the final DSL: editor keeps the member types
//           alongside `or editor_member`; viewer_member keeps referencing `editor`) — both tuple
//           shapes resolve, no share_link type exists yet, nothing leaks and nobody loses anything.
//   backfill copy every legacy user/group `editor` tuple to `editor_member` (write-IF-ABSENT — a
//           duplicate write 400s the whole FGA batch) and delete the legacy tuple. Idempotent.
//   verify  LEGACY_EDITOR_TUPLES must be 0 (thecompletion criterion) before Step B.
//   Step B  write the FINAL model (verbatim model.fga): `editor` gains the share_link types and
//           loses the member types, viewer_member flips to editor_member — in ONE model version, so
//           no version exists where `editor ∋ share_link` and `viewer_member → editor` both hold.
//
// FRESH stores (CI, setup:e2e / setup:server-test, a new self-host) bootstrap the final model
// directly and never run this. Run it against dev/prod persistent stores only:
//   pnpm --filter @wikistead/server fga:migrate-editor
// Enumeration is bounded by the spaces table (per-space object reads — OpenFGA has no list-all),
// exactly like migrate-218-direct-leaves.ts.
import { OpenFgaClient } from '@openfga/sdk'
import { transformer } from '@openfga/syntax-transformer'
import { readFileSync } from 'node:fs'
import postgres from 'postgres'

const FINAL_EDITOR = 'define editor: [share_link, share_link with non_expired] or editor_member'
const STEP_A_EDITOR = 'define editor: [user, group#member] or editor_member'
// #330 §1b appended `or moderator` to viewer_member AFTER this migration shipped — keep the constants
// exact-matching the CURRENT model.fga line so the loud-throw shape guard stays meaningful (a loose
// prefix match would silently accept future reshapes). Step A keeps the moderator branch: it is
// orthogonal to the editor split being migrated.
const FINAL_VIEWER_MEMBER = 'define viewer_member: [user, group#member] or editor_member or moderator'
const STEP_A_VIEWER_MEMBER = 'define viewer_member: [user, group#member] or editor or moderator'

export function finalDsl(): string {
  return readFileSync(new URL('../../../../infra/openfga/model.fga', import.meta.url), 'utf8')
}

// Step A is DERIVED from the final DSL (one source — no second .fga file to drift). If the final
// DSL's shape changes, the derivation fails LOUDLY instead of silently migrating with a wrong model.
export function stepADsl(final: string): string {
  if (!final.includes(FINAL_EDITOR) || !final.includes(FINAL_VIEWER_MEMBER)) {
    throw new Error('migrate-editor-274: the final model no longer matches the expected editor-split shape — update the derivation')
  }
  return final.replace(FINAL_EDITOR, STEP_A_EDITOR).replace(FINAL_VIEWER_MEMBER, STEP_A_VIEWER_MEMBER)
}

export async function writeModel(fga: OpenFgaClient, dsl: string): Promise<string> {
  const json = transformer.transformDSLToJSONObject(dsl)
  const res = await fga.writeAuthorizationModel(json as Parameters<OpenFgaClient['writeAuthorizationModel']>[0])
  return res.authorization_model_id!
}

const isMemberPrincipal = (user: string) => /^user:[^*\s]+$/.test(user) || /^group:[^\s]+#member$/.test(user)

async function readSpaceEditorTuples(fga: OpenFgaClient, spaceId: string, relation: 'editor' | 'editor_member'): Promise<string[]> {
  const out: string[] = []
  let token: string | undefined
  do {
    const res = await fga.read({ object: `space:${spaceId}` }, { ...(token ? { continuationToken: token } : {}) })
    for (const t of res.tuples ?? []) {
      if (t.key?.relation === relation && t.key.user && isMemberPrincipal(t.key.user)) out.push(t.key.user)
    }
    token = res.continuation_token || undefined
  } while (token)
  return out
}

// Copy each legacy user/group `editor` tuple to `editor_member` (write-if-absent), then delete the
// legacy tuple. Per-space, per-tuple — re-runnable on a mixed-state store at any point.
export async function backfillEditorMembers(fga: OpenFgaClient, spaceIds: string[]): Promise<{ moved: number }> {
  let moved = 0
  for (const spaceId of spaceIds) {
    const legacy = await readSpaceEditorTuples(fga, spaceId, 'editor')
    if (legacy.length === 0) continue
    const have = new Set(await readSpaceEditorTuples(fga, spaceId, 'editor_member'))
    for (const user of legacy) {
      if (!have.has(user)) {
        await fga.write({ writes: [{ user, relation: 'editor_member', object: `space:${spaceId}` }] })
      }
      await fga.write({ deletes: [{ user, relation: 'editor', object: `space:${spaceId}` }] })
      moved++
    }
  }
  return { moved }
}

// Thecompletion criterion: zero legacy member-principal `editor` tuples remain.
export async function countLegacyEditorTuples(fga: OpenFgaClient, spaceIds: string[]): Promise<number> {
  let n = 0
  for (const spaceId of spaceIds) n += (await readSpaceEditorTuples(fga, spaceId, 'editor')).length
  return n
}

const isMain = process.argv[1]?.endsWith('migrate-editor-274.ts')
if (isMain) {
  ;(async () => {
    const apiUrl = process.env.OPENFGA_API_URL ?? 'http://localhost:8080'
    const storeId = process.env.OPENFGA_STORE_ID
    if (!storeId) { console.error('OPENFGA_STORE_ID required'); process.exit(1) }
    const fga = new OpenFgaClient({ apiUrl, storeId })

    const dbUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!
    const sql = postgres(dbUrl, { max: 1, onnotice: () => {} })
    const spaces = (await sql<{ id: string }[]>`SELECT id FROM spaces`).map((r: { id: string }) => r.id)
    await sql.end()

    const final = finalDsl()
    console.log('step A: writing the transitional model…')
    const stepAId = await writeModel(fga, stepADsl(final))
    console.log(`OPENFGA_MODEL_ID(step A)=${stepAId}`)

    console.log(`backfill: ${spaces.length} spaces…`)
    const { moved } = await backfillEditorMembers(fga, spaces)
    console.log(`moved ${moved} legacy editor tuple(s) to editor_member`)

    const legacy = await countLegacyEditorTuples(fga, spaces)
    console.log(`LEGACY_EDITOR_TUPLES=${legacy}`)
    if (legacy !== 0) { console.error('legacy tuples remain — re-run; NOT writing the final model'); process.exit(1) }

    console.log('step B: writing the final model…')
    const finalId = await writeModel(fga, final)
    console.log(`OPENFGA_MODEL_ID=${finalId}`)
    console.log('done — update .env OPENFGA_MODEL_ID and respawn server/collab (dev), or roll the release job (prod).')
  })().catch((e) => { console.error(e); process.exit(1) })
}
