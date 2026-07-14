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
    let hasSpace = false
    let hasPublishedUser = false
    let hasPublishedLink = false
    for (const t of (tuples ?? []) as { key?: { user?: string; relation?: string; object?: string; condition?: Cond } }[]) {
      const k = t.key
      if (!k?.user || !k.relation || !k.object) continue
      if (k.relation === 'space') hasSpace = true
      if (k.relation === 'published' && k.user === 'user:*') hasPublishedUser = true
      if (k.relation === 'published' && k.user === 'share_link:*') hasPublishedLink = true
      const leaf = LEAF[k.relation]
      if (!leaf) continue // not a grant relation (private/restricted/space/parent/comment/comment_open) — skip
      // view_base@user:* is the PUBLIC grant — keep it on view_base (user:* stays a direct type there).
      if (k.relation === 'view_base' && k.user === 'user:*') continue
      // Anything left on manage/edit/view_base is a member/group/share-link direct grant → move to the leaf.
      // PRESERVE the `non_expired` condition: a time-bounded share link carries `condition` on the old grant;
      // dropping it would turn an expiring link into a PERMANENT one (a monotonic over-permit — collab
      // authenticate checks `view/edit` with `current_time`, so a condition-less leaf admits past expiry).
      writes.push({ user: k.user, relation: leaf, object: k.object, ...(k.condition ? { condition: k.condition } : {}) })
      deletes.push({ user: k.user, relation: k.relation, object: k.object })
    }
    if (hasSpace && !hasPublishedUser) writes.push({ user: 'user:*', relation: 'published', object: `page:${id}` })
    if (hasSpace && !hasPublishedLink) writes.push({ user: 'share_link:*', relation: 'published', object: `page:${id}` })
    const publishedWrites = writes.filter((w) => w.relation === 'published').length
    if (writes.length === 0) continue
    // Write the new leaves + published markers first, then delete the stale grants (a crash leaves a superset,
    // never a gap — the extra published marker is harmless, the un-migrated grant would only be a temporary loss).
    await fga.write({ writes }).catch((e: unknown) => { console.error(`write failed for page:${id}`, e); throw e })
    if (deletes.length) await fga.write({ deletes }).catch((e: unknown) => { console.error(`delete failed for page:${id}`, e); throw e })
    moved += writes.length - publishedWrites
    published += publishedWrites
    console.error(`page:${id}: moved ${writes.length - publishedWrites} grant(s) to *_direct` + (publishedWrites ? `, +${publishedWrites} published marker(s)` : ''))
  }
  console.log(`migrate-218-direct-leaves: moved ${moved} grant tuple(s) + ${published} published marker(s) across ${pages.length} page(s)`)
})().catch((err) => { console.error(err); process.exit(1) })
