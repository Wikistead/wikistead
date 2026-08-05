// #628 / ADR-215 §2: whether a NARROWED api key may reach the route it is calling.
//
// Narrowing is EE (the ruling: "CE " — running a roster of
// capabilities across several people and spaces is governance). It has to survive #178 lifting
// `packages/ee-server` out of this tree, so CE gets a hole rather than a branch: nothing registered
// means there is no narrowing, which is exactly CE's behaviour — CE cannot mint a narrowed key at all.
//
// The predicate answers for a SPECIFIC request. It is deliberately given the method and the registered
// route PATTERN rather than the raw URL: a raw URL never matches a path parameter, and a table keyed by
// one would silently miss every `/pages/:id` in the product.
export interface NarrowedKeyRequest {
  /** The capabilities this key carries. An empty list is still a narrowed key — it may reach nothing. */
  capabilities: readonly string[]
  method: string
  /** Fastify's `req.routeOptions.url` — the registered pattern, not the raw URL. */
  routePattern: string | undefined
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
