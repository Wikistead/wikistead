// Realtime collaboration server (Yjs + Hocuspocus). This is the security-critical
// join point: a single onAuthenticate accepts BOTH member (OIDC) and guest
// (app-signed share) tokens, resolves capability for the requested document, and
// enforces it before letting anyone into the Yjs room. Rooms are tenant-namespaced.
import * as Y from "yjs";
import { Hocuspocus } from "@hocuspocus/server";
import type { onAuthenticatePayload } from "@hocuspocus/server";
import { Redis } from "@hocuspocus/extension-redis";
import { Database } from "@hocuspocus/extension-database";
import IORedis from "ioredis";
import { docName } from "@wikistead/types";
import { loadYdoc, storeYdoc, compactIfBloated } from "./ydoc.js";
import { authenticate, parseDocName } from "./authenticate.js";
import { selectGuestConnectionsToClose, parseRevokeMessage } from "./revoke.js";

const server = new Hocuspocus({
  port: Number(process.env.COLLAB_PORT ?? 4100),

  // Hocuspocus debounces onStoreDocument at the server level (default: 2000ms).
  // Lowered to 800ms (#10): the persisted ydoc — and the has_unpublished_changes
  // flag set on store — is what gates the Publish button, so a shorter debounce
  // makes Publish responsive (and shrinks the crash-loss window). Does not block
  // the local-first <16ms edit target (Yjs handles local edits immediately).
  debounce: 800,

  extensions: [
    new Redis({ host: hostFromUrl(process.env.VALKEY_URL), port: portFromUrl(process.env.VALKEY_URL) }),

    // Ydoc persistence via Postgres. All DB access uses withTenant() so RLS
    // applies — cross-tenant reads return null, cross-tenant writes affect 0 rows.
    // onAuthenticate (above) runs before onLoadDocument, so by the time fetch/store
    // are called the principal is already authorized — persistence does not
    // re-check authorization but inherits the tenant boundary from documentName.
    new Database({
      fetch: async ({ documentName }) => {
        const { tenantId, pageId, ephemeral } = parseDocName(documentName);
        if (ephemeral) return null; // #92 / ADR-093: ephemeral Excalidraw room — never persisted; the
        // first client seeds it from the fence JSON, and the final scene is flushed to the page's
        // Y.Text fence (not here) on modal close. Empty initial state = seed-on-join.
        const state = await loadYdoc(tenantId, pageId);
        if (!state) return state;
        // #120 / ADR-040 (option 2): compact accumulated restore tombstones at COLD LOAD. fetch runs when
        // the doc is loaded from persistence — i.e. it is NOT resident on this pod (Hocuspocus keeps a
        // loaded doc in memory and only re-fetches after it has been unloaded), so re-encoding here is
        // safe: the connecting client receives the compacted state as its baseline and there is no
        // resident doc whose (old client-id/clock) state would fail to merge. Only rewrites when the
        // stored state is bloated (compactIfBloated returns null otherwise → normal docs untouched).
        // Persist the compacted bytes so the DB baseline shrinks (same content → the unpublished badge
        // is unaffected). NOTE (multi-pod): with the Valkey/redis extension another POD could have the
        // doc resident; a cross-pod "zero connections" gate (ADR-040 option 1) would be needed there — a
        // documented follow-up. Single-pod (the self-host default) is safe.
        const compacted = compactIfBloated(state);
        if (compacted) {
          await storeYdoc(tenantId, pageId, compacted);
          return compacted;
        }
        return state;
      },
      store: async ({ documentName, state, context }) => {
        const { tenantId, pageId, ephemeral } = parseDocName(documentName);
        if (ephemeral) return; // #92: ephemeral Excalidraw room is never persisted (flushed to the fence)
        const p = (context as any)?.principal;
        const createdBy = p?.kind === "member"  ? `user:${p.userId}`
                        : p?.kind === "guest"   ? `guest:${p.shareLinkId}`
                        : undefined;
        const result = await storeYdoc(tenantId, pageId, state, createdBy);
        // #114 / ADR-058: a store that EXHAUSTED its 0-row retries means the draft did NOT persist (the
        // page was deleted, or a stuck RLS gap) and the persisted checkpoint (pages.ydoc) did NOT advance
        // — the 0-row UPDATE changed nothing. Do NOT leave clients editing into a void that silently
        // drops on reconnect: disconnect them. On reconnect, onLoadDocument reloads the last GOOD
        // pages.ydoc and onAuthenticate re-checks FGA (404-ing a truly-deleted page). `blocked` (an
        // empty-overwrite REFUSED, existing bytes kept) is NOT data loss → those clients stay connected.
        if (!result.stored && !result.blocked) {
          const document = server.documents.get(documentName);
          if (document) {
            for (const conn of document.getConnections()) {
              try { conn.close(); } catch (err) { console.error(`[ydoc:store] disconnect failed for ${documentName}:`, err); }
            }
          }
        }
      },
    }),
  ],

  async onAuthenticate({ token, documentName }: onAuthenticatePayload) {
    return authenticate({ token, documentName });
  },
});

server.listen();

// ── Restore signal subscriber ─────────────────────────────────────────────
//
// Position: pages.ydoc is correctness (already updated by the API server before
// this publish). The Valkey signal is a performance optimisation for immediate
// propagation to currently-connected clients.
//
// If this subscriber is not running or the publish fails, connected clients
// receive the restored state on their next reconnect (onLoadDocument reads
// the already-updated pages.ydoc). Correctness is never lost.
const restoreSub = new IORedis(process.env.VALKEY_URL ?? "redis://localhost:6379");

restoreSub.psubscribe("wks:restore:*", (err) => {
  if (err) console.error("[restore:sub] subscribe failed:", err);
});

restoreSub.on("pmessage", (_pattern: string, channel: string, data: string) => {
  const documentName = channel.replace("wks:restore:", "");
  const document = server.documents.get(documentName);
  if (!document) return;  // not open; pages.ydoc already updated, next open loads it

  try {
    const update = Buffer.from(data, "base64");
    Y.applyUpdate(document, update);
    // Y.applyUpdate triggers Hocuspocus onChange → debounced onStoreDocument
    // → storeYdoc (which creates a new revision, making the restore undoable).
    // Redis extension also propagates the update to other Hocuspocus pods.
  } catch (err) {
    console.error(`[restore:apply] failed for ${documentName}:`, err);
  }
});

// ── Publish flush subscriber ───────────────────────────────────────────────
//
// The API server publishes the LAST PERSISTED draft (pages.ydoc), which lags the
// live doc by the onStoreDocument debounce. Before publishing, the API asks us to
// persist the live in-memory doc NOW so the snapshot includes the just-typed edits.
// We force a store (which also sets has_unpublished_changes accurately) and ack so
// the API can wait for completion, then read the fresh pages.ydoc. Presence/awareness
// are untouched — this is purely the persistence path.
//
// If the doc is not open here (no live edits in this pod), pages.ydoc is already
// current — we ack immediately. Request and ack use DISTINCT prefixes so the
// request pattern never matches an ack.
const flushSub = new IORedis(process.env.VALKEY_URL ?? "redis://localhost:6379");
const flushPub = new IORedis(process.env.VALKEY_URL ?? "redis://localhost:6379");

flushSub.psubscribe("wks:flushreq:*", (err) => {
  if (err) console.error("[flush:sub] subscribe failed:", err);
});

flushSub.on("pmessage", async (_pattern: string, channel: string, reqId: string) => {
  const documentName = channel.replace("wks:flushreq:", "");
  try {
    const document = server.documents.get(documentName);
    if (document) {
      const { tenantId, pageId } = parseDocName(documentName);
      // Persist the current in-memory state immediately (bypass the debounce). This
      // is exactly what the Database extension stores, just on demand.
      await storeYdoc(tenantId, pageId, Y.encodeStateAsUpdate(document));
    }
  } catch (err) {
    console.error(`[flush:apply] failed for ${documentName}:`, err);
  } finally {
    // Ack regardless: a store error or a not-open doc both mean "proceed" (pages.ydoc
    // is the best available snapshot). The API also has a timeout as a backstop.
    flushPub.publish(`wks:flushack:${reqId}`, "1").catch(() => {});
  }
});

// ── Share-link revoke subscriber (#106 / ADR-028) ──────────────────────────
//
// On revoke the API server deletes the FGA tuple (the authority — revocation is instant) and
// publishes wks:revoke:<documentName> with { shareLinkId }. We sever every still-connected
// guest on that link NOW, so a revoked guest stops editing immediately instead of lingering
// until the token TTL. Members and guests on OTHER links are left untouched — their
// presence/collab session must not be disrupted.
//
// Discarding unsynced guest edits is intentional (per the #106 approval): closing the socket
// drops anything the guest had not yet sent — revocation puts authorization above data
// preservation. Edits already synced before revoke remain (they were legitimate). A severed
// guest cannot rejoin: the collab onAuthenticate re-checks FGA on every connect and the tuple
// is gone, so any reconnect is rejected.
//
// Best-effort, like the restore/flush channels: if this is missed (Valkey down, doc not open
// in this pod), the token TTL + the reconnect FGA check are the backstop — latency degrades,
// never correctness.
const revokeSub = new IORedis(process.env.VALKEY_URL ?? "redis://localhost:6379");

revokeSub.psubscribe("wks:revoke:*", (err) => {
  if (err) console.error("[revoke:sub] subscribe failed:", err);
});

revokeSub.on("pmessage", (_pattern: string, channel: string, data: string) => {
  const documentName = channel.replace("wks:revoke:", "");
  const document = server.documents.get(documentName);
  if (!document) return; // nobody connected here; TTL + reconnect-check are the backstop
  const msg = parseRevokeMessage(data);
  if (!msg) return;
  for (const conn of selectGuestConnectionsToClose(document.getConnections(), msg.shareLinkId)) {
    try {
      conn.close(); // socket drops → unsynced edits discarded; reconnect is FGA-rejected
    } catch (err) {
      console.error(`[revoke:close] failed for ${documentName}:`, err);
    }
  }
});

// ── Title-dictionary invalidation fan-out (#224 / ADR-104 Finding B) ────────
//
// The API server publishes wks:dict:<tenantId> after every trusted-path (outbox) reindex —
// rename / privatise / delete / publish. We forward a STATELESS ping to every client connected
// to any of that tenant's rooms so it refetches its viewer-scoped title dictionary and stale
// colored links disappear in-window (the security-timing Done-gate).
//
// The forwarded payload deliberately carries NO pageId: this fan-out reaches EVERY connection
// in the tenant — including guests on unrelated share links — and a pageId would be an
// existence signal for pages the recipient cannot view. The ping only says "your dictionary
// may be stale"; each client re-derives its own viewer-scoped set from the authz-gated
// endpoint. No authorization is derived from this channel (display-cache liveness only; the
// onAuthenticate gate is untouched).
//
// Best-effort like the revoke/restore channels: a missed ping degrades to the client's next
// refetch, never to a wrong authorization.
const dictSub = new IORedis(process.env.VALKEY_URL ?? "redis://localhost:6379");

dictSub.psubscribe("wks:dict:*", (err) => {
  if (err) console.error("[dict:sub] subscribe failed:", err);
});

dictSub.on("pmessage", (_pattern: string, channel: string, _data: string) => {
  const tenantId = channel.replace("wks:dict:", "");
  const roomPrefix = `t:${tenantId}:p:`;
  server.documents.forEach((document, name) => {
    if (!name.startsWith(roomPrefix)) return;
    try {
      document.broadcastStateless(JSON.stringify({ type: "dict-invalidate" }));
    } catch (err) {
      console.error(`[dict:broadcast] failed for ${name}:`, err);
    }
  });
});

// ---- helpers ----
function hostFromUrl(u?: string) { return u ? new URL(u).hostname : "localhost"; }
function portFromUrl(u?: string) { return u ? Number(new URL(u).port || 6379) : 6379; }

export { docName };
