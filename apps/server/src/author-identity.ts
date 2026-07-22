import type { TenantDb } from './db/index.js'

// #486 / ADR-150 Addendum 2: resolve author subs to their display identity for a VIEW-GATED response.
//
// UNLIKE the /members/identities resolver (which is customized-only, to avoid a roster oracle on
// ARBITRARY client-supplied subs), the subs here are SERVER-SET on an already view-filtered result set,
// so full resolution is allowed: displayName = display_name_override ?? OIDC display_name — NEVER an
// email or an email-local-part (R4), null when both are null. hasAvatar reflects an uploaded avatar key.
//
// AUTHZ INVARIANTS (ADR-150 Addendum 2, reviewer R3):
//  - MUST be called on the CALLER'S RLS-scoped handle (req.db) so a cross-tenant / deleted sub resolves
//    to ABSENT (→ the caller reads null) — never a bare pool / admin connection (the #428/#479
//    silent-0-row trap: FORCE RLS on a context-less connection returns 0 rows, which reads as "no name"
//    but is really "wrong connection").
//  - MUST be applied AFTER the view filter, to the surviving set only — never to raw candidate rows
//    (RawRow[] / Meili candidates) before the FGA stage.
//  - Guest / anon subs are structurally dropped (they are not members; their pseudonym never queries).
export interface AuthorIdentity {
  readonly displayName: string | null
  readonly hasAvatar: boolean
}

export async function resolveAuthorIdentities(
  db: TenantDb,
  subs: readonly string[],
): Promise<Map<string, AuthorIdentity>> {
  const uniq = [...new Set(subs.filter((s) => s && !s.startsWith('guest:') && !s.startsWith('anon:')))]
  const out = new Map<string, AuthorIdentity>()
  if (uniq.length === 0) return out
  const rows = await db.sql<
    { sub: string; display_name: string | null; display_name_override: string | null; avatar_image_key: string | null }[]
  >`SELECT sub, display_name, display_name_override, avatar_image_key FROM members WHERE sub = ANY(${uniq})`
  for (const r of rows) {
    out.set(r.sub, { displayName: r.display_name_override ?? r.display_name ?? null, hasAvatar: r.avatar_image_key != null })
  }
  return out
}

// Convenience shape for a single author sub → the two fields a gated response carries. `sub` null/guest
// (a guest/anon author) → no name, no avatar (the client keeps its short "Guest abcd" label).
export function authorFields(map: Map<string, AuthorIdentity>, sub: string | null | undefined): { name: string | null; hasAvatar: boolean } {
  if (!sub) return { name: null, hasAvatar: false }
  const id = map.get(sub)
  return { name: id?.displayName ?? null, hasAvatar: id?.hasAvatar ?? false }
}
