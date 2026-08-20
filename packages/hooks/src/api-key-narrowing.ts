// #628 / ADR-215 §2: whether a NARROWED api key may reach the route it is calling.
//
// Narrowing is EE (the ruling: CE carries only what an individual user needs — running a roster of
// capabilities across several people and spaces is governance). It has to survive #178 lifting
// `packages/ee-server` out of this tree, so CE gets a hole rather than a branch: nothing registered
// means there is no narrowing, which is exactly CE's behaviour — CE cannot mint a narrowed key at all.
//
// The predicate answers for a SPECIFIC request. It is deliberately given the method and the registered
// route PATTERN rather than the raw URL: a raw URL never matches a path parameter, and a table keyed by
// one would silently miss every `/pages/:id` in the product.
export interface NarrowedKeyRequest {
  /**
   * The capabilities this key carries, or undefined when it is not narrowed that way.
   *
   * #637 slice 7: this was `readonly string[]`, and the call site passed `capabilities ?? []` — which
   * turned "not narrowed by capability" into "narrowed to nothing" and made a key confined only by SPACE
   * reach nothing at all. The whole distinction this file argues for, collapsed by a default value. An
   * empty list is still a key that may reach nothing; undefined is a key with no capability confinement.
   */
  capabilities?: readonly string[]
  method: string
  /** Fastify's `req.routeOptions.url` — the registered pattern, not the raw URL. */
  routePattern: string | undefined
  /**
   * #637 / ADR-216 §4: the spaces this key is confined to, when it is confined by space at all. Null is
   * "not confined that way" — it is NOT "confined to nothing", which an empty set means, exactly as an
   * empty capability list does.
   */
  spaces?: ReadonlySet<string> | null
  /**
   * #667 / ADR-221 §3: which rule reads this key, and the resource-type matrix when it carries one.
   *
   * Both travel, rather than the gate inferring the model from the matrix's presence: an EMPTY matrix is
   * "narrowed to nothing" and must not read as "no matrix, so use the v1 verbs" — the same
   * undefined-versus-empty distinction the two fields above spell out, one level up.
   */
  permissionModel?: 1 | 2
  permissions?: Readonly<Record<string, string>> | null
}

/**
 * Whether a key is narrowed AT ALL — in any dimension.
 *
 * #637 / ADR-216 §4. The gate used to ask this by testing `capabilities` for truthiness at its call site,
 * which answered "no" for a key narrowed only by space. Everything narrowing buys hangs off that answer:
 * the refusal on credential-minting routes, and the route table itself. So a key confined to one space
 * would have been treated as unconfined, and `POST /auth/collab-token` mints a token carrying the OWNER's
 * identity — the live-editing surface derives authority from OpenFGA for that subject and has never heard
 * of API keys. One space in, every space out.
 *
 * It lives here, beside the seam, rather than at the call site: the whole point is that there is one
 * answer to "is this key narrowed", and a second dimension added next month must not need the call site
 * to be found again.
 *
 * #667 / ADR-221 §3: that month arrived, and the prediction was exact. A v2 key carries a resource-type
 * matrix and NEITHER of the first two fields — so this function would have answered "not narrowed", and
 * the key would have been handed its owner's whole tenant, past the credential-minting refusal and past
 * the route table both. The same fail-open as #637, in the same function, for the third dimension.
 *
 * The reason the prediction held is worth keeping: every dimension is optional on its own, so "is it
 * narrowed" can only ever be a disjunction, and a disjunction silently loses a term that nobody adds.
 */
export function isNarrowedKey(key: {
  capabilities?: readonly string[] | null
  spaces?: ReadonlySet<string> | readonly string[] | null
  permissions?: Readonly<Record<string, string>> | null
}): boolean {
  return key.capabilities != null || key.spaces != null || key.permissions != null
}

/** True when the request is allowed. A route the table does not know MUST answer false. */
export type NarrowedKeyGate = (req: NarrowedKeyRequest) => boolean

let _gate: NarrowedKeyGate | null = null

export function registerNarrowedKeyGate(gate: NarrowedKeyGate): void {
  _gate = gate
}

export function getNarrowedKeyGate(): NarrowedKeyGate | null {
  return _gate
}

/** Test-only: restore the default (no narrowing) so registry state cannot leak between tests. */
export function resetNarrowedKeyGate(): void {
  _gate = null
}
