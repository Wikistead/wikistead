// #667 / ADR-221 §1 §5: the resource types the issuing form offers, and how a `scope` falls out of them.
//
// The list is here rather than fetched because it is a vocabulary, not data: the server validates every
// cell against its own declaration (`unknown_type` / `unknown_action` / `unreachable_permission`), so a
// stale copy here is refused rather than silently accepted. Fetching it would buy freshness for a list
// that changes when this file's neighbours do.
//
// The ORDER is the order the form draws, and it is not alphabetical: content first, because that is what
// most integrations want, then the administrative types. A reader scanning the list should meet the
// ordinary case before the dangerous one.
//
// #667 (ruling, 2026-08-09): the types no longer carry an `admin` flag. §10 used it to shorten the
// default lifetime for administrative keys, which left everything else defaulting to NEVER EXPIRES
// the most dangerous option, as the default, on the majority of keys. The distinction is gone and the
// thirty-day default applies to all of them. It also removes a judgement nobody could make reliably
// every new type would have asked "is this administrative?", and the answer drifting is how `audit` and
// `webhooks` — a tenant's security ledger and a content egress — ended up on the long side.
export type Action = "read" | "write";

export interface ResourceTypeOption {
  /** the wire value, and the i18n key suffix */
  id: string;
  /** false when no classified route requires `write` on this type — the server refuses such a cell */
  writable: boolean;
}

export const RESOURCE_TYPE_OPTIONS: readonly ResourceTypeOption[] = [
  { id: "pages", writable: true },
  { id: "page_publishing", writable: true },
  { id: "page_lifecycle", writable: true },
  { id: "page_sharing", writable: true },
  { id: "page_moderation", writable: true },
  { id: "comments", writable: true },
  { id: "attachments", writable: true },
  // read-only in the map: no route requires `search: write`, and offering a cell the server will refuse
  // is the same defect as offering a capability no route implements (#642's family).
  { id: "search", writable: false },
  { id: "activity", writable: false },
  { id: "spaces", writable: true },
  { id: "space_settings", writable: true },
  { id: "space_publishing", writable: true },
  { id: "space_lifecycle", writable: true },
  { id: "space_sharing", writable: true },
  { id: "space_moderation", writable: true },
  { id: "members", writable: true },
  { id: "roles", writable: true },
  { id: "tenant_settings", writable: true },
  { id: "webhooks", writable: true },
  { id: "analytics", writable: true },
  { id: "audit", writable: false },
];

export type Matrix = Record<string, Action>;

/**
 * #667 / ADR-221 §5: `scope` is derived, never asked.
 *
 * Every cell `read` gives a read key; one `write` cell makes it a write key. The METHOD CEILING stays a
 * separate mechanism in the server — it refuses a non-GET by HTTP method alone, consulting no table —
 * so an all-read key cannot write even when the route map is wrong. That independence is what #642
 * bought, and it is why this function only decides what to ask for, never what is enforced.
 */
export const derivedScope = (matrix: Matrix): Action =>
  Object.values(matrix).some((a) => a === "write") ? "write" : "read";

/**
 * #667 (ruling): the lifetime EVERY new key starts on.
 *
 * The user's words: 30 . It used to depend on whether
 * an administrative type was selected, which meant an ordinary key defaulted to never expiring — the
 * most dangerous choice, pre-selected, on most keys. One default is both consistent and safer.
 *
 * A DEFAULT and not a cap. The ceiling belongs to the tenant (`api_key_max_age_days`, #628), and a
 * second one visible only to some selections would make the form refuse what the API grants — the
 * inversion `key-expiry-choices` was written to undo. "Never" stays selectable.
 *
 * Thirty days off the ladder the tenant already offers, or the nearest rung under it — asking for
 * thirty on a seven-day policy would put the Select on a value that does not exist, which renders as a
 * bare chevron (#603). That calculation is why this is not simply the string "30".
 */
export const NEW_KEY_DEFAULT_DAYS = 30;

export function newKeyDefaultExpiry(choices: readonly { value: string; days: number | null }[]): string {
  const withDays = choices.filter((c) => c.days !== null);
  if (withDays.length === 0) return choices[0]?.value ?? "";
  const exact = withDays.find((c) => c.days === NEW_KEY_DEFAULT_DAYS);
  if (exact) return exact.value;
  // no thirty-day rung: take the longest one that is still under it, or the shortest offered when the
  // tenant's whole ladder sits above thirty
  const under = withDays.filter((c) => (c.days as number) < NEW_KEY_DEFAULT_DAYS);
  const pick = under.length > 0
    ? under.reduce((a, b) => ((a.days as number) > (b.days as number) ? a : b))
    : withDays.reduce((a, b) => ((a.days as number) < (b.days as number) ? a : b));
  return pick.value;
}
