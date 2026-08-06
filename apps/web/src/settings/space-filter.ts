// #661: filtering the space picker on the API key form.
//
// A pure function, separate from the panel, because the rule that matters here is not "does typing
// shorten the list" — it is what happens to a space you ALREADY TICKED when it stops matching. If the
// filter simply hides it, the form still submits it, and the person issuing a credential cannot see
// what they are about to hand over. That is a worse failure than a long list, and it is invisible in a
// screenshot: the list looks right, the key reaches somewhere nobody chose to send it.
//
// So a picked space is never filtered out. It is not a courtesy — it is the invariant that keeps what
// the screen says and what the form submits the same thing.
export interface SpaceOption {
  id: string;
  name: string;
}

/**
 * The options to show, given the query and what is already ticked.
 *
 * Matching is case-insensitive and substring, on the NAME — the id is a slug the reader did not choose
 * and mostly does not know. Whitespace-only input is no filter at all rather than a filter that matches
 * nothing, because a stray space should not empty the list.
 */
export function filterSpaceOptions(
  spaces: readonly SpaceOption[],
  query: string,
  picked: readonly string[],
): SpaceOption[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...spaces];
  const chosen = new Set(picked);
  return spaces.filter((s) => chosen.has(s.id) || s.name.toLowerCase().includes(q));
}

/**
 * How many spaces the query hides. Shown so a long list that has been narrowed does not read as a short
 * list — "3 of 40" is a different fact from "3", and the second one invites issuing a key against a
 * roster the reader believes is complete.
 */
export const hiddenCount = (spaces: readonly SpaceOption[], shown: readonly SpaceOption[]): number =>
  Math.max(0, spaces.length - shown.length);
