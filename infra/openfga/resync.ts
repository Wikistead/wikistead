// fga:resync (#499) — rebuild the DB-DERIVABLE structural FGA tuples from the app database, for MIGRATING a
// store to a new datastore or RECOVERING one that was wiped/degraded (the dev memory-engine wipe, or a
// migration from one store to another). It reconstructs only the tuples whose source of truth is the DB:
//   1. tenant memberships          — user:<sub> member/admin tenant:<tid>            (members table)
//   2. group memberships           — user:<sub> member group:<hash>                 (members.groups, #111)
//   3. space hierarchy             — tenant:<tid> tenant space:<sid>                 (spaces table)
//   4. personal-space owner grant  — user:<owner> manager space:<sid>               (spaces.personal_owner_sub)
//   5. PUBLISHED-page tuples        — space:<sid> space page:<pid>  +  the published PAIR
//                                     (user:* / share_link:* published page:<pid>)  (pages, published_at NOT NULL)
//   6. TRASHED-page marker          — user:* / share_link:* trashed page:<pid>       (pages, deleted_root_id NOT NULL)
//
// These tuple SHAPES mirror the runtime write paths exactly — space create (spaces.ts grantSpaceAccess:
// tenant/manager), page create + publish (pages.ts: space-link + published pair), trash (pages.ts trashPage:
// the trashed marker pair), member + group provision (admin/member + group#member) — and the seed
// (infra/openfga/seed.ts).
//
// KNOWN LIMITATION — NOT recovered here (FGA is their ONLY source of truth; no DB column exists to derive
// them, so a wiped/migrated store cannot get them back through this script):
//   - space GRANTS (viewer/editor/moderator/manager assigned via grantSpaceAccess / role assignment) — FGA-only.
//   - the space-creation default (tenant:<tid>#member space_creator tenant:<tid>) — FGA-only since ADR-171/#471.
//     migrate-445 wrote the tenant_settings.space_creation_policy value into the wildcard tuple, then DROPped
//     the column (mig 075 — point of no return). There is no DB column left to derive it from; a default role's
//     createSpaces capability sets it at runtime, so it lives in FGA only (like the other markers below).
//   - visibility / policy MARKERS — public view, PRIVATE, RESTRICTED, FROZEN, comment_open audience, and
//     per-share-link view/edit markers — all FGA-only. (Consequence to be aware of: a PRIVATE published page
//     gets its space-link back here but NOT its private marker, so after recovery it is space-visible until
//     the marker is re-applied. There is no DB source to restore the marker from — a genuine recovery gap.)
//   - DRAFT pages' creator-only grant — FGA-only. A draft is deliberately NOT space-linked, so this script
//     writes the space-link + published pair ONLY for pages with published_at IS NOT NULL. It therefore NEVER
//     turns a draft into a space-visible page (the invariant that makes an over-broad resync an access bug).
//   - share_links (token → grant, incl. their expiry conditions) — FGA-only.
//   - custom role_assignments — deferred to a follow-up (expansionTuples over the role_assignments table).
//   - template audience tuples — partly DB-derivable (templates table); deferred, low priority.
//
// Idempotent (read-before-write, per tuple — FGA write batches are all-or-nothing, so per-tuple keeps a
// partially-present store converging cleanly, the #445 lesson). Run AFTER fga:bootstrap (the model must
// exist) against the target datastore, with DATABASE_URL / OPENFGA_* set. Dev/migration/recovery only.
import postgres from 'postgres'
import { createHash } from 'node:crypto'
import { OpenFgaClient } from '@openfga/sdk'
import type { TupleKey } from '@openfga/sdk'

// The SAME deterministic, tenant-salted FGA group id the runtime sync uses (auth/group-sync.ts groupFgaId).
// Inlined so this script stays self-contained (like the other infra/openfga migrate scripts). MUST match
// group-sync.ts exactly, or a rebuilt group membership lands on the wrong id and group grants silently break.
const groupFgaId = (tenantId: string, name: string): string =>
  createHash('sha256').update(`${tenantId} ${name}`).digest('hex').slice(0, 24)

;(async () => {
  const apiUrl = process.env.OPENFGA_API_URL ?? 'http://localhost:8080'
  const storeId = process.env.OPENFGA_STORE_ID
  const modelId = process.env.OPENFGA_MODEL_ID
  if (!storeId) { console.error('OPENFGA_STORE_ID required (run fga:bootstrap first)'); process.exit(1) }
  const fga = new OpenFgaClient({ apiUrl, storeId, ...(modelId ? { authorizationModelId: modelId } : {}) })

  const dbUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL
  if (!dbUrl) { console.error('DATABASE_URL required'); process.exit(1) }
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} })

  // Write a tuple only if it (relation, on this object, for this user) is not already present — non-destructive
  // and safe to re-run. Reads are scoped to the exact (user, object) so a re-run is cheap at dev/migration scale.
  let wrote = 0
  async function ensure(t: TupleKey) {
    const { tuples } = await fga.read({ user: t.user, object: t.object })
    if ((tuples ?? []).some((x: { key?: TupleKey }) => x.key?.relation === t.relation && x.key?.user === t.user)) return
    await fga.write({ writes: [t] })
    wrote += 1
  }

  try {
    // 1/2. tenant memberships + group memberships (both from the members table). The space-creation default
    // (tenant:<tid>#member space_creator tenant:<tid>) is NOT rebuilt here — it is FGA-only since ADR-171/#471.
    // Its DB column (tenant_settings.space_creation_policy) was DROPped in migration 075 after migrate-445
    // copied its value into the wildcard tuple (point of no return), so there is nothing left to derive it from
    // (see the KNOWN LIMITATION note above). Querying it here crashed the whole resync at the first statement
    // with `column ts.space_creation_policy does not exist`, writing zero tuples (#499).
    const members = await sql<{ tenant_id: string; sub: string; role: string; groups: string[] | null }[]>`
      SELECT tenant_id, sub, role, groups FROM members`
    for (const m of members) {
      await ensure({ user: `user:${m.sub}`, relation: 'member', object: `tenant:${m.tenant_id}` })
      if (m.role === 'admin') await ensure({ user: `user:${m.sub}`, relation: 'admin', object: `tenant:${m.tenant_id}` })
      // #111 group memberships: members.groups → group:<hash>#member (the SAME source syncMemberGroups writes
      // from). Rebuilt so group grants resolve after recovery (dropping them silently would fail every group
      // grant — an under-grant, not a leak, but the doc must not claim to rebuild memberships and skip these).
      for (const g of m.groups ?? []) {
        await ensure({ user: `user:${m.sub}`, relation: 'member', object: `group:${groupFgaId(m.tenant_id, g)}` })
      }
    }
    console.log(`members: ${members.length}`)

    // 3/4. spaces → hierarchy + the personal-space owner's manager grant.
    const spaces = await sql<{ id: string; tenant_id: string; personal_owner_sub: string | null }[]>`
      SELECT id, tenant_id, personal_owner_sub FROM spaces`
    for (const s of spaces) {
      await ensure({ user: `tenant:${s.tenant_id}`, relation: 'tenant', object: `space:${s.id}` })
      if (s.personal_owner_sub) await ensure({ user: `user:${s.personal_owner_sub}`, relation: 'manager', object: `space:${s.id}` })
    }
    console.log(`spaces: ${spaces.length}`)

    // 5. PUBLISHED pages only → the space-link + the published pair. Drafts (published_at IS NULL) are skipped:
    // their creator-only grant is FGA-only, and space-linking them here would publish them (an access bug).
    const published = await sql<{ id: string; space_id: string }[]>`
      SELECT id, space_id FROM pages WHERE published_at IS NOT NULL`
    for (const p of published) {
      await ensure({ user: `space:${p.space_id}`, relation: 'space', object: `page:${p.id}` })
      await ensure({ user: 'user:*', relation: 'published', object: `page:${p.id}` })
      await ensure({ user: 'share_link:*', relation: 'published', object: `page:${p.id}` })
    }
    console.log(`published pages: ${published.length}`)

    // TRASHED pages (design-review BLOCK): trash is an ADDITIVE `trashed` marker pair that makes the page a
    // uniform 404 while its underlying grants SURVIVE (restore = delete the marker, ADR-003 / pages.ts
    // trashPage). `published_at` is NOT cleared on trash, so a trashed+published page's space-link/published
    // pair above is CORRECT (it must come back on restore) — but WITHOUT re-writing the `trashed` marker the
    // page would resurface after recovery (deleted content leaks). Rebuild the marker for every trashed row
    // (deleted_root_id stamps the whole trashed subtree), independent of publish state.
    const trashed = await sql<{ id: string }[]>`
      SELECT id FROM pages WHERE deleted_root_id IS NOT NULL`
    for (const p of trashed) {
      await ensure({ user: 'user:*', relation: 'trashed', object: `page:${p.id}` })
      await ensure({ user: 'share_link:*', relation: 'trashed', object: `page:${p.id}` })
    }
    console.log(`trashed pages: ${trashed.length}`)
  } finally {
    await sql.end()
  }

  console.log(`fga:resync done — ${wrote} tuple(s) written. NOT recovered (FGA-only): space grants, the space-creation default (space_creator, FGA-only since ADR-171), visibility/policy markers (private/restricted/frozen/public/comment_open/share-link), drafts' creator grant, share_links, custom role assignments.`)
})().catch((err) => { console.error(err); process.exit(1) })
