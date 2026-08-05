// #578 (review rejection, 2026-08-05): how a person is named when the product can no longer name them.
//
// A subject id is a 70-character hex string. Four screens fell back to printing it raw when the name
// could not be resolved — somebody who left the tenant, a cross-tenant principal, or one of the orphan
// grants #624 recorded. The reader gets `89e72bb9f2d5effccbf6fe2784f01fe06057f960f06ccb109ef4a0cdef17791c`
// where a name belongs, and #523 / ADR-190 canonicalised display names precisely so that people
// surfaces stop doing that.
//
// The GROUP side already had the answer: an id that resolves to nothing is an ORPHAN, and the row says
// so instead of showing the hash — while keeping its revoke, because unreadable must never mean
// unremovable. This is the same rule for a person, written once so the four screens cannot drift into
// four wordings.
//
// The short id is kept because it is the only thing that distinguishes two orphans from each other in a
// list. Eight characters is what the ticket's own example showed and enough to tell rows apart; the rest
// is noise nobody can act on.
export function shortPrincipalId(sub: string): string {
  const bare = sub.replace(/^user:/, '');
  return bare.length <= 12 ? bare : `${bare.slice(0, 8)}…`;
}

/**
 * The label for a person, given whatever the server could resolve.
 *
 * `resolved` is the server's answer (a display name, or null when it has none). `unknownLabel` is the
 * translated noun — passed in rather than looked up here so this stays a pure function the way the group
 * row builders already are.
 *
 * A name that is present but blank counts as absent: a member row with `display_name = ''` would
 * otherwise render as an empty cell, which is worse than saying the name is unknown.
 */
export function memberLabel(sub: string, resolved: string | null | undefined, unknownLabel: string): string {
  const name = resolved?.trim();
  return name ? name : `${unknownLabel} (${shortPrincipalId(sub)})`;
}
