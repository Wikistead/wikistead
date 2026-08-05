// #628 (review rejection): the lifetimes a key may be given, DERIVED from the tenant's ceiling.
//
// The first version filtered a fixed ladder — [7, 30, 90, 365] — down to what the ceiling allowed, and a
// ceiling of 3 days left nothing at all: no choice, no default, an empty select. The server accepts
// 2 days quite happily, so the product refused through its own form what its API would have granted, and
// the tighter a tenant's policy the fewer keys anyone could make. That is the ceiling's intent inverted.
//
// Deriving means the ceiling always yields at least one offer — itself. The ladder is a set of ROUND
// numbers to prefer, not the answer.
const LADDER = [7, 30, 90, 365] as const;

export interface ExpiryChoice {
  /** Days, or "" for "never expires" — the wire's `null`. */
  value: string;
  days: number | null;
}

/**
 * @param maxAgeDays the tenant's ceiling, or null for none.
 */
export function expiryChoices(maxAgeDays: number | null | undefined): ExpiryChoice[] {
  if (maxAgeDays == null) {
    // No ceiling: the round numbers, plus the option to never expire.
    return [{ value: "", days: null }, ...LADDER.map((d) => ({ value: String(d), days: d }))];
  }
  // A ceiling of 0 or less would mean "no key may exist", which the server does not accept either
  // (`setApiKeyMaxAgeDays` refuses anything below 1). Treat it as the tightest real policy rather than
  // rendering an empty control.
  const cap = Math.max(1, Math.floor(maxAgeDays));
  const rungs = LADDER.filter((d) => d < cap);
  // The ceiling itself is always offered, and always last — someone who set a 3-day policy means for
  // keys to last 3 days, not for the form to be empty. Deduped so a ceiling that IS a rung (90) does
  // not appear twice.
  return [...rungs, cap].map((d) => ({ value: String(d), days: d }));
}

/** The choice a form should start on: the longest thing the tenant permits. */
export function defaultExpiry(maxAgeDays: number | null | undefined): string {
  const all = expiryChoices(maxAgeDays);
  // No ceiling → "never", which is the first entry and the longest lifetime there is. With a ceiling →
  // the ceiling itself, which is last. Either way it is a value that EXISTS in the list: a Select whose
  // value matches no option renders as a bare chevron with no width (#603 fixed that once).
  return maxAgeDays == null ? "" : all[all.length - 1]!.value;
}
