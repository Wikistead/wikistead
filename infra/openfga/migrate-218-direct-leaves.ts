// #218 / ADR-103 migration: after the model flip, `manage`/`edit`/`view` are PURELY COMPUTED — a direct
// member/group/share-link grant that used to live on `manage`/`edit`/`view_base` is now IGNORED by the model
// (those relations have no direct types), so the grantee silently LOSES access. This one-shot migration moves
// every existing DIRECT page grant to its `*_direct` leaf (manage→manage_direct, edit→edit_direct,
// view_base@member/group/link→view_direct). It preserves `view_base@user:*` (the public grant — user:* stays a
// direct type on view_base), and never touches private/restricted/space/parent/comment/comment_open.
//
// Runs AFTER `fga:bootstrap` writes the new model, against the SAME persistent datastore (dev + prod). Fresh
// e2e/server-test stacks re-seed from scratch and do NOT need it. Idempotent: a second run finds nothing to
// move (the direct relations are already the leaves).
//
// Enumeration is bounded by the pages table (a `page:<id>` per row) rather than "all FGA tuples" (OpenFGA has
// no list-all), reading each page's tuples and rewriting the grant ones.
import postgres from 'postgres'
import { OpenFgaClient } from '@openfga/sdk'

const LEAF: Record<string, string> = { manage: 'manage_direct', edit: 'edit_direct', view_base: 'view_direct' }

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
  let published = 0
  for (const { id } of pages) {
    const { tuples } = await (fga as any).read({ object: `page:${id}` })
    type Cond = { name: string; context: Record<string, unknown> }
    const writes: { user: string; relation: string; object: string; condition?: Cond }[] = []
    const deletes: { user: string; relation: string; object: string }[] = []
    // #218 / ADR-103 addendum (DRAFT GATE): a PUBLISHED page (has a `page#space` link) must carry the
    // `published` marker PAIR so its PUBLISHED children keep INHERITING folder grants after the flip
    // (`*_inherited = *_from_parent and published`). A draft (no page#space) gets NONE — it stays creator-only.
    const keys = (tuples ?? []).map((t: { key?: { user?: string; relation?: string; object?: string; condition?: Cond } }) => t.key)
      .filter((k): k is { user: string; relation: string; object: string; condition?: Cond } => !!k?.user && !!k?.relation && !!k?.object)
    // FIRST pass — index EVERY existing tuple so `write-if-absent` sees the whole set regardless of read order
    // (building it incrementally would miss a leaf that appears AFTER the old grant it dedupes against). This
    // keeps the one-shot fully idempotent on a mixed / partly-migrated store — OpenFGA 400s a duplicate write.
    const existing = new Set(keys.map((k) => `${k.user}|${k.relation}|${k.object}`))
    const hasSpace = keys.some((k) => k.relation === 'space')
    // SECOND pass — move each old grant relation to its `*_direct` leaf (skipping any leaf that already exists).
    for (const k of keys) {
      const leaf = LEAF[k.relation]
      if (!leaf) continue // not a grant relation (private/restricted/space/parent/comment/comment_open/*_direct) — skip
      // view_base@user:* is the PUBLIC grant — keep it on view_base (user:* stays a direct type there).
      if (k.relation === 'view_base' && k.user === 'user:*') continue
      // Move to the leaf, PRESERVING the `non_expired` condition (dropping it would turn an expiring share link
      // into a PERMANENT one — a monotonic over-permit; collab authenticate checks with `current_time`).
      if (!existing.has(`${k.user}|${leaf}|${k.object}`)) {
        writes.push({ user: k.user, relation: leaf, object: k.object, ...(k.condition ? { condition: k.condition } : {}) })
      }
      deletes.push({ user: k.user, relation: k.relation, object: k.object }) // remove the stale (now typeless) grant
    }
    if (hasSpace && !existing.has(`user:*|published|page:${id}`)) writes.push({ user: 'user:*', relation: 'published', object: `page:${id}` })
    if (hasSpace && !existing.has(`share_link:*|published|page:${id}`)) writes.push({ user: 'share_link:*', relation: 'published', object: `page:${id}` })
    const publishedWrites = writes.filter((w) => w.relation === 'published').length
    if (writes.length === 0 && deletes.length === 0) continue
    // Write the new leaves + published markers first, THEN delete the stale grants (a crash leaves a superset,
    // never a gap — the extra published marker is harmless, the un-migrated grant would only be a temporary loss).
    // Deletes run even when there is nothing to write (a mixed-state store where the leaf already exists but the
    // stale old-relation tuple — now typeless under the flipped model — still needs removing).
    if (writes.length) await fga.write({ writes }).catch((e: unknown) => { console.error(`write failed for page:${id}`, e); throw e })
    if (deletes.length) await fga.write({ deletes }).catch((e: unknown) => { console.error(`delete failed for page:${id}`, e); throw e })
    moved += writes.length - publishedWrites
    published += publishedWrites
    console.error(`page:${id}: moved ${writes.length - publishedWrites} grant(s) to *_direct` + (publishedWrites ? `, +${publishedWrites} published marker(s)` : ''))
  }
  console.log(`migrate-218-direct-leaves: moved ${moved} grant tuple(s) + ${published} published marker(s) across ${pages.length} page(s)`)
})().catch((err) => { console.error(err); process.exit(1) })
