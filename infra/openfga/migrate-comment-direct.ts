// #411 / ADR-153 migration: the trash subtraction turned `comment` into a PURELY COMPUTED relation
// (`comment_live but not trashed`) with a new `comment_direct` leaf as the write target — an existing
// direct comment grant sitting on `comment` is now typeless (ignored by the model), so the grantee would
// silently lose commenting AND drop out of the search viewer denorm (doc-builder reads comment_direct).
// This one-shot moves every `page#comment@user/group` tuple to `comment_direct`.
//
// Runs AFTER `fga:bootstrap` writes the new model, against the SAME persistent datastore (dev + prod).
// Fresh e2e/server-test stacks re-seed from scratch and do NOT need it. Idempotent: a second run finds
// nothing to move. Same shape as migrate-218-direct-leaves.ts (the precedent leaf split).
import postgres from 'postgres'
import { OpenFgaClient } from '@openfga/sdk'

;(async () => {
  const apiUrl = process.env.OPENFGA_API_URL ?? 'http://localhost:8080'
  const storeId = process.env.OPENFGA_STORE_ID
  const modelId = process.env.OPENFGA_MODEL_ID
  if (!storeId) { console.error('OPENFGA_STORE_ID required'); process.exit(1) }
  const fga = new OpenFgaClient({ apiUrl, storeId, ...(modelId ? { authorizationModelId: modelId } : {}) })

  const dbUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL!
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} })
  const pages = await sql<{ id: string }[]>`SELECT id FROM pages`
  await sql.end()

  let moved = 0
  for (const { id } of pages) {
    const { tuples } = await (fga as any).read({ object: `page:${id}` })
    const keys = (tuples ?? [])
      .map((t: { key?: { user?: string; relation?: string; object?: string } }) => t.key)
      .filter((k: { user?: string; relation?: string; object?: string } | undefined): k is { user: string; relation: string; object: string } => !!k?.user && !!k?.relation && !!k?.object)
    const existing = new Set(keys.map((k: { user: string; relation: string; object: string }) => `${k.user}|${k.relation}|${k.object}`))
    const writes: { user: string; relation: string; object: string }[] = []
    const deletes: { user: string; relation: string; object: string }[] = []
    for (const k of keys) {
      if (k.relation !== 'comment') continue // only the old direct comment grants move
      if (!existing.has(`${k.user}|comment_direct|${k.object}`)) {
        writes.push({ user: k.user, relation: 'comment_direct', object: k.object })
      }
      deletes.push({ user: k.user, relation: 'comment', object: k.object })
    }
    if (writes.length === 0 && deletes.length === 0) continue
    // Leaf first, stale delete second — a crash leaves a superset (temporary double grant on the same
    // capability), never a gap.
    if (writes.length) await fga.write({ writes }).catch((e: unknown) => { console.error(`write failed for page:${id}`, e); throw e })
    if (deletes.length) await fga.write({ deletes }).catch((e: unknown) => { console.error(`delete failed for page:${id}`, e); throw e })
    moved += deletes.length
  }
  console.error(`migrated ${moved} comment grant tuple(s) to comment_direct`)
})().catch((e) => { console.error(e); process.exit(1) })
