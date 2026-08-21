// #813 / ADR-248 §3.1: whether this client's edits are reaching the server.
//
// The provider reports every part of this and `connect()` used to subscribe to none of it — the
// information existed and was thrown away at the seam. What the guest in the demo saw was the
// consequence: a socket that had been refused five minutes earlier, an editor that kept accepting
// keystrokes into a local document, and a publish that said "published" over a draft none of it had
// ever reached.
//
// ── Why four conjuncts, and why the fourth is not decoration ────────────────────────────────────
//
// A READ-ONLY connection is connected, authenticated and synced, and throws every keystroke away.
// The server drops the update and answers `writeSyncStatus(false)`; the provider's
// `applySyncStatusMessage` does nothing at all when `applied` is false — no error, no event. And
// `synced` was set even earlier, by the server's SyncStep2. So the first three conjuncts describe a
// connection that is silently discarding the document, which is the exact defect this exists to
// remove. The server already puts `read-write` / `readonly` on the authenticated message and the
// provider keeps it in `authorizedScope`; the client simply was not reading it.
//
// That state is reachable in the product, not only in principle: a member whose edit right is
// withdrawn mid-session reconnects read-only, because the client's cached `canEdit` still lets the
// editor open the room.
//
// ── What this is NOT ───────────────────────────────────────────────────────────────────────────
//
// It is not "has everything I typed arrived". That is `hasUnsyncedChanges`, which is the stronger
// question and the wrong signal to render from: it moves on every keystroke, so subscribing the UI
// to it would put a per-keystroke store under the editor — what `dirtySignal.ts` exists to avoid,
// after driving that through host React state regressed the presence e2e. Publish asks it once, at
// the click. This one moves only on connection events, which is what a banner can sit on.

/** The provider's own vocabulary, narrowed to what liveness reads. */
export type AuthorizedScope = 'read-write' | 'readonly' | undefined

export interface LivenessInputs {
  /** the socket is up (`WebSocketStatus.Connected`) */
  connected: boolean
  /** the server accepted the token */
  authenticated: boolean
  /** what the server said this connection may do */
  authorizedScope: AuthorizedScope
  /** the initial document exchange completed */
  synced: boolean
}

/**
 * Are this client's edits reaching the server?
 *
 * Pure, so the rule can be measured without a socket — and so the read-only case, which is the one
 * that has no observable event at all, can be driven directly.
 */
export function isLive(s: LivenessInputs): boolean {
  return s.connected && s.authenticated && s.authorizedScope === 'read-write' && s.synced
}

/**
 * Why the edits are not arriving, for the band that says so.
 *
 * `read-only` is told apart from the rest deliberately: the others are "we are trying to reconnect",
 * and this one is "you no longer have the right to edit this", which is not a waiting state and will
 * not fix itself.
 */
export type NotLiveReason = 'connecting' | 'unauthenticated' | 'read-only' | 'syncing'

export function notLiveReason(s: LivenessInputs): NotLiveReason | null {
  if (isLive(s)) return null
  if (!s.connected) return 'connecting'
  if (!s.authenticated) return 'unauthenticated'
  if (s.authorizedScope !== 'read-write') return 'read-only'
  return 'syncing'
}
