// #813 / ADR-248 §3.5: one session object with two faces.
//
// A guest's minted token is BOTH the collaboration socket's credential and the `Authorization` for
// every HTTP call the guest makes — the page tree, the title, the task toggle, and publish. It lives
// for five minutes and nothing renewed it, so a guest who paused mid-sentence came back to a socket
// that had been refused and a publish that answered 401. What the demo saw was the second half: the
// editor kept accepting keystrokes into a local document and publish said "published".
//
// ── Why this is an object and not a piece of React state ────────────────────────────────────────
//
// Putting the token in state is the obvious implementation and it is the one that must not be written.
// The editor keys two effects on the credential: the collaboration effect (whose teardown destroys the
// provider, the socket AND the Y.Doc) and the surface effect (whose teardown destroys every CodeMirror
// view and nulls this surface's presence). A token that changes as a React value therefore throws away
// either the characters typed while disconnected — the very thing the refresh exists to save — or the
// caret, the undo history and the scroll position, every five minutes, mid-sentence.
//
// So the token is held here and offered two ways:
//
//   getToken()   a REF-STABLE function the provider holds. `HocuspocusProvider` accepts
//                `() => Promise<string>` and calls it on every connection, so the next connection uses
//                the current token without the socket or the document being rebuilt.
//   current()    the value, read per HTTP request at the moment of the request.
//
// Neither is a value any effect depends on. That is the whole design.
//
// ── The getter must not throw ───────────────────────────────────────────────────────────────────
//
// A throwing token getter reaches the provider's `permissionDeniedHandler`, which disconnects and stops
// the library reconnecting on its own. So a refresh that fails returns the token it already holds: the
// connection then fails for the honest reason (the server refuses an expired token), the banner says
// so, and reconnection stays the session's business rather than being latched off.
import { fetchGuestToken, refreshGuestToken, type GuestToken } from "../data/apiClient";

/** Why the session is over. `session_ended` is recoverable by entering again; the others are not. */
export type SessionEnd = "unauthorized" | "gone";

/**
 * Seconds left on a token, read from its own `exp` claim.
 *
 * The claims are plaintext (base64url; nothing here verifies one — the server is the only thing that
 * does), so the client can tell how long it has without being told. Reading the expiry from the token
 * rather than from a timer set at mint time means a tab that was asleep wakes up with the truth
 * instead of with an interval that stopped counting.
 *
 * ⚠️ A token this cannot read is reported as EXPIRED, so the session renews rather than assuming it
 * has time. Erring the other way leaves a guest holding a credential nothing accepts.
 */
export function secondsLeft(token: string, nowMs: number = Date.now()): number {
  const part = token.split(".")[1];
  if (!part) return 0;
  try {
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    if (typeof exp !== "number") return 0;
    return exp - Math.floor(nowMs / 1000);
  } catch {
    return 0;
  }
}

/**
 * Is it time to renew?
 *
 * Lazily, at connection time, rather than on a timer: an idle tab that never reconnects costs the
 * store nothing, and the tab that does reconnect gets a token minted for that moment. The margin is
 * what a connection plus its first requests need — renewing at the last second hands out a credential
 * that expires between the getter returning it and the socket presenting it.
 */
export const RENEW_MARGIN_SECONDS = 60;

/**
 * The backoff the session waits before putting itself back on a socket (#875 / ADR-248 §3.6).
 *
 * BOUNDED on purpose: the ruling is that an endless retry is another kind of silence. When the list
 * runs out the session stops knocking and the banner keeps saying the edits are not saved — which is
 * true, and is the state a person can act on.
 */
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000];
export function needsRenewal(token: string, nowMs?: number): boolean {
  return secondsLeft(token, nowMs) <= RENEW_MARGIN_SECONDS;
}

/** How the session waits. Injected so a test can measure the delay instead of living through it. */
export type Schedule = (fn: () => void, ms: number) => void;

export interface GuestSession {
  /** Ref-stable. Handed to the collaboration provider, called on every connection. */
  getToken: () => Promise<string>;
  /** The current value, for one HTTP request. Never stored in React state. */
  current: () => string;
  /** Non-null once the session cannot be continued at all. */
  ended: () => SessionEnd | null;
  /**
   * Register what puts this session back on a socket, or `null` when that thing goes away.
   *
   * #875 (review rejection): the getter deliberately never throws, so a refresh that could not complete
   * hands back the token it already holds and the server closes the connection on its own terms. The
   * provider does NOT reconnect after that — `permissionDeniedHandler` disconnects it — so somebody
   * has to knock again, and ADR-248 §3.6 says it is this object, because the backoff has to survive
   * across connections and the provider is rebuilt by them.
   *
   * A guest who hit the refresh rate limit once had nothing bring them back at all.
   */
  onReconnect: (fn: (() => void) | null) => void;
  /** Retries still available before the session stops knocking. For the pin, and for the banner. */
  retriesLeft: () => number;
}

/**
 * Hold one guest session's credential and keep it alive.
 *
 * `onMinted` is how a host learns that the capability or the document name came back different — it is
 * NOT how the token reaches anybody, and the distinction is the design: a host that re-renders on this
 * must not put the token into the tree.
 */
export function makeGuestSession(
  linkId: string,
  initial: GuestToken,
  onMinted?: (minted: GuestToken) => void,
  schedule: Schedule = (fn, ms) => { setTimeout(fn, ms); },
): GuestSession {
  let token = initial.token;
  let end: SessionEnd | null = null;
  let inFlight: Promise<void> | null = null;
  let reconnect: (() => void) | null = null;
  let attempt = 0;
  let waiting = false;

  // One knock in flight at a time, and never after the session is over. Reaching the end of the list
  // is a stop, not a wrap-around: see RETRY_DELAYS_MS.
  //
  // ⚠️ The `end` here is defence in depth and is NOT reachable today — `renew()` is the only caller and
  // `getToken()` will not renew once the session has ended. The guard that a test can actually drive is
  // the one inside the callback below: a knock scheduled BEFORE the credential died would otherwise
  // fire after it. Said outright so nobody reads this line as covered.
  const scheduleRetry = () => {
    if (waiting || end) return;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return;
    attempt += 1;
    waiting = true;
    schedule(() => {
      waiting = false;
      if (!end) reconnect?.();
    }, delay);
  };

  const adopt = (minted: GuestToken) => {
    token = minted.token;
    attempt = 0; // a renewal that worked buys back the full ladder for the next bad stretch

    // The capability can legitimately change under a guest (a link narrowed while they were reading),
    // and the host decides what to do about it. The token is deliberately not part of that news.
    onMinted?.(minted);
  };

  const renew = async (): Promise<void> => {
    const outcome = await refreshGuestToken(linkId, token);
    if (outcome.kind === "renewed") { adopt(outcome.minted); return; }
    // Keep what we hold — the server will refuse it and say so honestly — and knock again after the
    // delay. "The next connection asks again" was the whole gap: nothing opened a next connection.
    if (outcome.kind === "retry") { scheduleRetry(); return; }
    if (outcome.kind === "ended") { end = outcome.why; return; }
    // `reenter`: the twelve-hour ceiling. Exchanging again with the still-live token in hand is what
    // carries the pseudonym across the boundary — and the pseudonym is the attribution key, so a fresh
    // one would split one person's twelve hours of work between two names in the page's own history.
    const again = await fetchGuestToken(linkId);
    if (again === "password_required") { end = "unauthorized"; return; } // the door asks again; this session is over
    if (again === "rate_limited" || again === null) { scheduleRetry(); return; } // not an answer about the session
    adopt(again);
  };

  return {
    getToken: async () => {
      // ⚠️ Never throws. See the note at the top: a throwing getter latches the provider's reconnect off.
      if (!end && needsRenewal(token)) {
        // One renewal at a time. Two connections opening together (the page and a macro's ephemeral
        // room) would otherwise each mint, and the second would replace a token the first had already
        // handed to a socket.
        inFlight ??= renew().finally(() => { inFlight = null; });
        await inFlight;
      }
      return token;
    },
    current: () => token,
    ended: () => end,
    onReconnect: (fn) => { reconnect = fn; },
    retriesLeft: () => Math.max(0, RETRY_DELAYS_MS.length - attempt),
  };
}
