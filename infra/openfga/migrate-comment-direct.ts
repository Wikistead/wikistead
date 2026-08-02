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
    // #574 review: a truncated read leaves `comment` tuples past the first fifty unmigrated, and
    // ADR-199's model flip then removes those people's comment access without a word.
    const tuples: { key?: { user?: string; relation?: string; object?: string } }[] = []
    {
      let continuationToken: string | undefined
      do {
        const res = await (fga as any).read({ object: `page:${id}` }, { ...(continuationToken ? { continuationToken } : {}) })
        tuples.push(...(res.tuples ?? []))
        continuationToken = res.continuation_token || undefined
      } while (continuationToken)
    }
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
    // #574 review 2: paginating the read above made these writes reachable at the size they
    // were paginated FOR. OpenFGA refuses a batch over max_tuples_per_write (measured on this stack:
    // 100 accepted, 101 rejected), so a page with more than a hundred grants threw and the migration
    // stopped on that page every run — fail-loud, but stuck. Chunked, the way the #553 migration and
    // packages/authz already do it. Order is unchanged: every write chunk lands before any delete, so
    // a crash still leaves a superset rather than a gap.
    const CHUNK = 100
    for (let i = 0; i < writes.length; i += CHUNK) {
      const part = writes.slice(i, i + CHUNK)
      await fga.write({ writes: part }).catch((e: unknown) => { console.error(`write failed for page:${id}`, e); throw e })
    }
    for (let i = 0; i < deletes.length; i += CHUNK) {
      const part = deletes.slice(i, i + CHUNK)
      await fga.write({ deletes: part }).catch((e: unknown) => { console.error(`delete failed for page:${id}`, e); throw e })
    }
    moved += deletes.length
  }
  console.error(`migrated ${moved} comment grant tuple(s) to comment_direct`)
})().catch((e) => { console.error(e); process.exit(1) })
