import * as Y from "yjs";
import { HocuspocusProvider, HocuspocusProviderWebsocket, WebSocketStatus } from "@hocuspocus/provider";
import { isLive, notLiveReason, type AuthorizedScope, type LivenessInputs, type NotLiveReason } from "./liveness";
import { createUnsyncedLatch } from "./unsyncedSignal";

/** What a subscriber is told when the connection's state changes (#813 / ADR-248 §3.1). */
export interface Liveness {
  live: boolean;
  reason: NotLiveReason | null;
}

// docName must match the server: "t:<tenantId>:p:<pageId>".
// token is either a member OIDC token or an app-issued guest share token —
// the SAME collab server endpoint accepts both (see apps/collab).
export function connect(opts: {
  url: string;
  docName: string;
  /**
   * #813 / ADR-248 §3.5: a value, or a getter the provider calls on EVERY connection.
   *
   * A guest's token is renewed while they read. Handing the provider a getter is what lets the next
   * connection use the current token without the socket, the awareness or the Y.Doc being rebuilt —
   * and rebuilding the Y.Doc would throw away the characters typed while disconnected, which is the
   * thing the renewal exists to save.
   */
  token: string | (() => Promise<string>);
  /**
   * #813 / ADR-248 §3.1: called whenever the answer to "are this client's edits arriving" changes.
   *
   * The provider reported all of this before and `connect()` discarded it — the information existed
   * and died at this seam, which is why a guest could type for five minutes into a socket that had
   * been refused. Optional so the ephemeral room and the tests that do not care are unaffected.
   */
  onLiveness?: (state: Liveness) => void;
  /**
   * #994 / ADR-276 §Decision 1: called when "a local edit exists that is not reaching the server"
   * flips — the CONTENT question the not-live toast should have been standing on, next to
   * `onLiveness`'s CONNECTION question. Same shape, same rarity: it moves on connection events, not
   * on keystrokes (see `unsyncedSignal.ts` for why the AND with liveness makes that a property
   * rather than a hope).
   */
  onUnsyncedChanges?: (unsynced: boolean) => void;
  /**
   * #875 / ADR-248 §3.6: hand the session the knock that re-attaches this document.
   *
   * Called with a function while the connection exists and with `null` when it is torn down. The
   * provider will not reconnect itself once `permissionDeniedHandler` has disconnected it, and the
   * backoff has to outlive any one provider, so the session holds it and this is where it gets it.
   */
  registerReconnect?: (fn: (() => void) | null) => void;
}) {
  const doc = new Y.Doc();
  // Create the WebSocket transport explicitly. When HocuspocusProvider is given
  // a `url` it auto-creates an internal websocket that `provider.destroy()` does
  // NOT close (destroy only detaches the document provider) — leaking a socket
  // that keeps reconnecting on every page switch. Owning the socket lets the
  // caller close it in disconnect() below.
  const socket = new HocuspocusProviderWebsocket({ url: opts.url });
  // The four inputs of the liveness rule, kept here rather than read off the provider on demand:
  // `authorizedScope` survives a disconnect on the provider, so asking it after the socket dropped
  // would report the last connection's answer as if it were this one's.
  const state: LivenessInputs = { connected: false, authenticated: false, authorizedScope: undefined, synced: false };
  let lastLive: boolean | null = null;
  let lastReason: NotLiveReason | null = null;
  // #994 / ADR-276: the CONTENT half of the same seam. Built before the provider because the
  // provider's constructor can fire `onStatus` synchronously, and `report()` feeds this.
  const unsynced = createUnsyncedLatch((v) => opts.onUnsyncedChanges?.(v));
  const report = () => {
    const live = isLive(state);
    const reason = notLiveReason(state);
    // Only on CHANGE. The band must not be a per-event store under the editor, and `synced` in
    // particular is re-announced on every reconnect.
    if (live === lastLive && reason === lastReason) return;
    lastLive = live;
    lastReason = reason;
    unsynced.noteLive(live);
    opts.onLiveness?.({ live, reason });
  };

  // eslint-disable-next-line prefer-const -- the callbacks below close over it; it is assigned once, here.
  let provider: HocuspocusProvider;
  provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: opts.docName,
    document: doc,
    token: opts.token,
    onStatus: ({ status }) => {
      state.connected = status === WebSocketStatus.Connected;
      // A dropped socket invalidates everything the LAST connection established. The one that carries
      // the weight is `authenticated`: a socket coming back says nothing about whether the token was
      // accepted this time, and a token refused on reconnect is the reported accident itself.
      //
      // ⚠️ Measured: clearing `authorizedScope` here changes no observable answer while `authenticated`
      // is also cleared — `notLiveReason` reads the scope only after both of those. It is kept because
      // leaving one connection's permission lying around for the next one to find is a trap, not
      // because a test would catch its absence. The test holds `authenticated`; this comment is the
      // rest of the truth.
      if (!state.connected) {
        state.authenticated = false;
        state.authorizedScope = undefined;
        state.synced = false;
      }
      report();
    },
    onAuthenticated: () => {
      // ⚠️ The event carries NO payload — `authenticatedHandler` assigns the scope to the provider and
      // then emits bare (measured in the shipped bundle; the callback's type says `() => void`). So
      // the scope is read off the instance, here, at the only moment it is known to be current.
      state.authenticated = true;
      state.authorizedScope = provider.authorizedScope as AuthorizedScope;
      report();
    },
    onAuthenticationFailed: () => {
      // The provider fires this, then disconnects itself. Recording it here means the band can say
      // "you are not signed in to this document" rather than "reconnecting…" for a token that a
      // reconnect will present again, unchanged, and be refused for again.
      state.authenticated = false;
      state.authorizedScope = undefined;
      state.synced = false;
      report();
    },
    onSynced: () => {
      state.synced = true;
      report();
    },
    onDisconnect: () => {
      state.connected = false;
      state.authenticated = false;
      state.authorizedScope = undefined;
      state.synced = false;
      report();
    },
  });
  // #994 / ADR-276 §Decision 1. SET from the DOC, not from the provider's counter: a document with
  // no local edits never fires this, whatever `resetUnsyncedChanges()` put in that counter on the
  // last socket open. `origin !== provider` is the provider's OWN predicate for "this update did not
  // come off the wire" (`documentUpdateHandler` returns early on `origin === this`), so remote
  // updates and broadcast-channel echoes are excluded by the same rule that excludes them there.
  const onDocUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin !== provider) unsynced.noteLocalUpdate();
  };
  doc.on("update", onDocUpdate);
  // CLEAR on the provider's ACK. This is the one thing the provider's counter is authoritative
  // about — that the server has taken the updates — and the only thing read from it.
  const onUnsyncedCount = (n: number) => unsynced.noteAck(n);
  provider.on("unsyncedChanges", onUnsyncedCount);
  // The starting answer, before any event: not live. A surface that renders before the first
  // callback must not begin by claiming the edits are safe.
  report();
  // SINGLE canonical CRDT type. Both surfaces bind to this same Y.Text — no
  // XmlFragment, no bridging. This is what makes cross-surface presence trivial.
  const ytext = doc.getText("content");

  // Full teardown: drop presence first (no ghost cursor), detach the document
  // provider, AND close the underlying socket (no WS leak), then free the doc.
  // Robust to rapid page switches and React StrictMode double-mounts.
  const disconnect = () => {
    // Unregister FIRST: a scheduled knock that fires after teardown would reconnect a provider the
    // caller has just thrown away, and the socket below is about to be closed under it.
    opts.registerReconnect?.(null);
    doc.off("update", onDocUpdate);
    provider.off("unsyncedChanges", onUnsyncedCount);
    try {
      provider.awareness?.setLocalState(null);
    } catch {
      /* awareness already gone */
    }
    provider.destroy();
    socket.destroy();
    doc.destroy();
  };

  opts.registerReconnect?.(() => provider.connect());
  return { doc, provider, socket, ytext, disconnect };
}

// #502 / ADR-184 slice 2b: a one-shot "synced" latch. A co-occupied island seeds the shared ephemeral body
// ONLY AFTER the room's initial sync completes — that is the precondition (ephemeral-island.ts) under which
// the seeded-guard closes the join race the single-writer election alone cannot (a still-syncing late joiner
// who is the new min could otherwise re-seed). This latch resolves ONCE and, crucially, fires a callback
// added AFTER sync IMMEDIATELY, so a seeder that checks in late never misses the edge. Pure + unit-testable
// (no Hocuspocus/network); connectEphemeral wires the provider's onSynced into it below.
export interface SyncedLatch {
  readonly synced: boolean;
  markSynced(): void;
  onSynced(cb: () => void): void;
}
export function makeSyncedLatch(): SyncedLatch {
  let synced = false;
  let waiters: (() => void)[] = [];
  return {
    get synced() { return synced; },
    markSynced() {
      if (synced) return; // idempotent — a second sync event never re-fires the waiters
      synced = true;
      const fire = waiters;
      waiters = [];
      for (const cb of fire) cb();
    },
    onSynced(cb: () => void) {
      if (synced) cb(); // already synced → fire now (a late seeder must not miss the edge)
      else waiters.push(cb);
    },
  };
}

// #92 / ADR-093: an EPHEMERAL collab session for level-2 Excalidraw co-editing. Connects to the
// page's ephemeral room `t:<tenant>:p:<pageId>:x:<anchor>` (the collab server admits it with the same
// page-EDIT authority and NEVER persists it — the scene is flushed to the fence on close). Returns a
// fresh Y.Doc (scene lives in a Y.Map, not the page Y.Text) + awareness (who's drawing) + a destroy().
// This is a HOST-provided seam (the excalidraw macro receives it, keeping MacroContext={theme} narrow).
export interface EphemeralSession {
  doc: Y.Doc;
  awareness: HocuspocusProvider["awareness"];
  // #502 / ADR-184 slice 2b: fire once the room's initial sync has completed (or immediately if already
  // synced). The island seeds its shared body inside this callback so the seeded-guard closes the join race.
  onSynced: (cb: () => void) => void;
  destroy: () => void;
}
// #813 / ADR-248 §3.9: the macro's temporary room is in scope too — it authenticates the same way, so
// a token that died while the modal was open would refuse it for the same reason.
export function connectEphemeral(opts: { url: string; docName: string; anchor: string; token: string | (() => Promise<string>) }): EphemeralSession {
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: opts.url });
  const latch = makeSyncedLatch();
  // eslint-disable-next-line prefer-const -- the callbacks below close over it; it is assigned once, here.
  let provider: HocuspocusProvider;
  provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: `${opts.docName}:x:${opts.anchor}`, // the ephemeral room (server: parseDocName ⇒ ephemeral)
    document: doc,
    token: opts.token,
    onSynced: () => latch.markSynced(), // #502: the seed timing seam (registered before sync, so it fires)
  });
  if (provider.isSynced) latch.markSynced(); // belt-and-braces: already synced by the time we get here
  const destroy = () => {
    try { provider.awareness?.setLocalState(null); } catch { /* gone */ }
    provider.destroy();
    socket.destroy();
    doc.destroy();
  };
  return { doc, awareness: provider.awareness, onSynced: (cb) => latch.onSynced(cb), destroy };
}
