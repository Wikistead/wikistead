// #607 (review rejection, 2026-08-04): which of a space's settings tabs a caller can actually reach.
//
// The defect this exists to end: the server grew a verb (`space#access_manager`, whose whole purpose is
// running the member roster) and three UI gates were written by hand against `capability === "manage"`
// plus a list of exceptions. `canModerate` had been added to those lists; `canManageAccess` had not. So
// the roster routes answered 204 to a principal who could not reach the screen that calls them — the
// feature existed and was unusable, which no server test could see.
//
// One function answers it, for the layout, the landing redirect and the sidebar alike, and a pin walks
// the payload's OWN signal fields: whatever the server reports as a capability of this space must open
// at least one tab. A fourth verb added tomorrow fails that pin on arrival rather than shipping locked.
export interface SpaceSignals {
  capability?: "view" | "edit" | "manage";
  canModerate?: boolean;
  canManageAccess?: boolean;
}

/** The tab keys, in the order they are shown. */
export const SPACE_TAB_KEYS = ["general", "members", "pages", "import", "analytics", "trash", "moderation"] as const;
export type SpaceTabKey = (typeof SPACE_TAB_KEYS)[number];

/**
 * What each non-manager signal opens. A manager gets everything; every other verb opens exactly the
 * tab that IS its power — the #326 precedent (a moderator enters settings for the patrol queue and
 * nothing else), applied by rule instead of by a second hand-written condition.
 */
const TAB_FOR: { readonly [K in keyof Omit<SpaceSignals, "capability">]-?: SpaceTabKey } = {
  canModerate: "moderation",
  canManageAccess: "members",
};

export function reachableSpaceTabs(space: SpaceSignals | undefined): SpaceTabKey[] {
  if (!space) return [];
  if (space.capability === "manage") return [...SPACE_TAB_KEYS];
  const open = new Set<SpaceTabKey>();
  for (const [signal, tab] of Object.entries(TAB_FOR) as [keyof typeof TAB_FOR, SpaceTabKey][]) {
    if (space[signal] === true) open.add(tab);
  }
  // one order for everyone: the tab strip does not rearrange itself per caller
  return SPACE_TAB_KEYS.filter((k) => open.has(k));
}

/** Where entering `/settings` lands: the first tab this caller can reach. */
export function landingSpaceTab(space: SpaceSignals | undefined): SpaceTabKey | null {
  return reachableSpaceTabs(space)[0] ?? null;
}
