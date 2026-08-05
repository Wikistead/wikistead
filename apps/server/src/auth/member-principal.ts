import type { TenantDb } from '../db/index.js'

// #624: a grant names somebody. The validators around the product check the SHAPE of a principal
// (`/^user:[^*\s]+$/`) and stop there, so `user:` followed by any string at all was accepted — the
// server answered 204 while writing an FGA tuple nobody holds.
//
// It is not theoretical. The permissions dialog had a fallback that sent whatever was typed in the box
// as a sub, and the roster displays a raw sub when no member row can name it, so a reader could copy the
// hex off their own screen and paste it back in. Four such rows existed in dev, `origin='manual'`.
//
// Three things follow from a grant to a principal who is not here:
//
//   - the grant REPORTS SUCCESS and confers nothing — the #596 / #606 family;
//   - the tuple is permanent: no member row means no member deletion, so nothing ever sweeps it;
//   - the roster shows an unreadable identifier, which #523 / #582 spent themselves removing.
//
// WHY REFUSE RATHER THAN MARK IT UNCONFIRMED. An unconfirmed GROUP grant is deliberate (#578 OQ4): a
// manager names a directory group before anybody carrying it has signed in, and a group's identity is a
// NAME a human knows. A sub is not — it is minted by a connection (`wc<conn8>_<external>`) or by this
// product (`wlocal_<uuid>`), and nobody types one from memory. There is no case where an administrator
// legitimately knows a sub that has not arrived yet, so a grace period would be for nothing.
//
// WHY THE ROUTE HANDLERS AND NOT THE SHARED GRANT FUNCTIONS. Measured, both ways: inside the five shared
// functions it turns 125 existing tests red, at the request boundary 19. The difference is not fixture
// convenience — those functions are the mechanism, and the boundary is where untrusted input arrives,
// which is the line this repo already draws ("the UI is convenience, the server is the fortress"). The
// server's side of that line is the request. `member-principal-guard-624` keeps it honest by requiring
// every route file that validates a principal's shape to also apply this.
//
// WHERE IN THE HANDLER, AND WHY IT MATTERS. After the resource's existence-bind and authority check
// wherever one exists — measured: placed before them in the role-assignment route, a cross-tenant
// resource id answered 400 `not_a_member` instead of the uniform 404 that hides whether it exists
// (#445's existence-hiding line, pinned). The guard must never be the first thing that speaks.
//
// THE CHECK IS ON THE TENANT HANDLE, so RLS scopes it: a sub belonging to another tenant is simply
// absent here, which is the same answer as a sub belonging to nobody — and the right one. A cross-tenant
// grant is exactly as wrong as a typo'd one. It discloses nothing the caller cannot already read: they
// are looking at this resource's roster when they ask.
export async function assertGranteeIsMember(db: TenantDb, principal: string): Promise<void> {
  // Groups pass untouched — see the note above. So does anything that is not a user principal; the shape
  // validators at each call site keep their own vocabulary and this only narrows the user case.
  if (!principal.startsWith('user:')) return
  const sub = principal.slice('user:'.length)
  const rows = await db.sql<{ one: number }[]>`SELECT 1 AS one FROM members WHERE sub = ${sub} LIMIT 1`
  if (rows.length > 0) return
  // 400, not 404: the caller supplied a bad argument, and this is an administrator-facing surface where
  // ADR-195 §9 asks for the reason rather than the uniform not-found a stranger would get.
  throw Object.assign(
    new Error('that principal is not a member of this tenant — grant access to somebody who is here'),
    { statusCode: 400, code: 'not_a_member' },
  )
}
