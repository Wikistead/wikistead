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
import { loadYdoc, storeYdoc } from "./ydoc.js";
import { authenticate, parseDocName } from "./authenticate.js";

const server = new Hocuspocus({
  port: Number(process.env.COLLAB_PORT ?? 4100),

  // Hocuspocus debounces onStoreDocument at the server level (default: 2000ms).
  // Store fires 2s after the last document change — does not block the
  // local-first <16ms edit target (Yjs handles local edits immediately).
  debounce: 2000,

  extensions: [
    new Redis({ host: hostFromUrl(process.env.VALKEY_URL), port: portFromUrl(process.env.VALKEY_URL) }),

    // Ydoc persistence via Postgres. All DB access uses withTenant() so RLS
    // applies — cross-tenant reads return null, cross-tenant writes affect 0 rows.
    // onAuthenticate (above) runs before onLoadDocument, so by the time fetch/store
    // are called the principal is already authorized — persistence does not
    // re-check authorization but inherits the tenant boundary from documentName.
    new Database({
      fetch: async ({ documentName }) => {
        const { tenantId, pageId } = parseDocName(documentName);
        return loadYdoc(tenantId, pageId);
      },
      store: async ({ documentName, state, context }) => {
        const { tenantId, pageId } = parseDocName(documentName);
        const p = (context as any)?.principal;
        const createdBy = p?.kind === "member"  ? `user:${p.userId}`
                        : p?.kind === "guest"   ? `guest:${p.shareLinkId}`
                        : undefined;
        await storeYdoc(tenantId, pageId, state, createdBy);
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

// ---- helpers ----
function hostFromUrl(u?: string) { return u ? new URL(u).hostname : "localhost"; }
function portFromUrl(u?: string) { return u ? Number(new URL(u).port || 6379) : 6379; }

export { docName };
