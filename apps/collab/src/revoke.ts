// Active guest disconnect on share-link revoke (#106 / ADR-028) — selection + parsing.
//
// Extracted as pure functions so the security-critical "who gets disconnected" decision is
// directly unit-testable without a live Hocuspocus/WebSocket. The Valkey wiring lives in
// index.ts; this module only decides the target set and parses the signal payload.

// Minimal shape of a Hocuspocus connection we depend on. `context` is the AuthResult returned
// by onAuthenticate (see authenticate.ts), so guests carry { principal: { kind, shareLinkId } }.
export interface ConnectionLike {
  context?: { principal?: { kind?: string; shareLinkId?: string } } | null
  close: () => void
}

// Select the connections to forcibly close for a revoked share link.
//
// ONLY guest connections whose shareLinkId matches are selected. Members are never touched,
// and guests connected via a DIFFERENT share link are never touched — their presence/collab
// session must stay intact (disrupting unrelated sessions would be both a regression and a
// mini-DoS). Every guest on the revoked link matches (one link can have many connected
// guests), so none is missed.
export function selectGuestConnectionsToClose<C extends ConnectionLike>(
  connections: C[],
  shareLinkId: string,
): C[] {
  if (!shareLinkId) return []
  return connections.filter((c) => {
    const p = c.context?.principal
    return p?.kind === 'guest' && p.shareLinkId === shareLinkId
  })
}

// Parse the JSON payload published on wks:revoke:<documentName>. Returns null for anything
// malformed (logged-and-ignored at the call site) so a bad message can never close the wrong
// connections or throw in the subscriber.
export function parseRevokeMessage(raw: string): { shareLinkId: string } | null {
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object' && typeof (v as { shareLinkId?: unknown }).shareLinkId === 'string') {
      const shareLinkId = (v as { shareLinkId: string }).shareLinkId
      if (shareLinkId) return { shareLinkId }
    }
  } catch {
    /* malformed payload — ignore */
  }
  return null
}
