// #813 / ADR-248 §3.10: a member's collaboration credential, held outside React and renewed on demand.
//
// `COLLAB_TOKEN_TTL` is 300 seconds and the provider fetched `/auth/collab-token` once, at session
// bootstrap, with no renewal. A member who reconnected six minutes later failed to authenticate
// exactly as a guest did — and by the detach in §3.6 then stopped receiving this document's messages
// in silence, with `live` false, so publish and the checkbox stayed withheld until a reload.
//
// ⚠️ A PLAIN OBJECT, for the same reason `guest-session.ts` is one. The editor keys its collaboration
// effect on the credential, and that effect's teardown destroys the provider, the socket AND the Y.Doc.
// A token that renews as a React value therefore throws away the characters typed while disconnected —
// the thing the renewal exists to save — every five minutes, mid-sentence. So: one function, the same
// one forever, asked at connection time.
//
// Unlike the guest case there is no pseudonym to carry and no password to reason about: the route
// re-derives everything from the cookie session, so nothing about authority moves.
import { needsRenewal } from "./guest-session";

export interface CollabTokenSource {
  /** Ref-stable. Handed to the collaboration provider, called on every connection. */
  get: () => Promise<string>;
  /** Adopt a token minted elsewhere (the bootstrap probe already fetched one). */
  set: (token: string) => void;
  /** Forget it — a socket opened after a sign-out must not present the last person's credential. */
  clear: () => void;
}

/**
 * @param mint asks the server for a new token; `null` when it could not.
 * @param fixed a credential that IS the session and cannot be renewed (the dev-token bypass).
 */
export function makeCollabTokenSource(mint: () => Promise<string | null>, fixed?: string): CollabTokenSource {
  let held = fixed ?? "";
  let inFlight: Promise<void> | null = null;

  return {
    get: async () => {
      // The dev bypass IS the credential; there is no route to ask and nothing to renew.
      if (fixed && held === fixed) return held;
      if (held && !needsRenewal(held)) return held;
      // One renewal at a time: two connections opening together (the page and a macro's ephemeral
      // room) would otherwise each mint, and the second would replace a token the first had already
      // handed to a socket.
      inFlight ??= (async () => {
        const fresh = await mint().catch(() => null);
        // ⚠️ Keep what we hold when the mint fails. A getter that THROWS reaches the provider's
        // permissionDeniedHandler, which disconnects and latches reconnection off (§3.6); one that
        // returns "" asks the server to refuse an empty credential for no reason. Let the server
        // refuse the token we have, honestly, and let the retry in #875 knock again.
        if (fresh) held = fresh;
      })().finally(() => { inFlight = null; });
      await inFlight;
      return held;
    },
    set: (token) => { held = token; },
    clear: () => { held = ""; },
  };
}
