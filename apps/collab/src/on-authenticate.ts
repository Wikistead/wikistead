// The Hocuspocus onAuthenticate hook, extracted from the server construction in index.ts so the
// SHIPPED handler — not a re-implementation of it — is what an enforcement test drives.
//
// #811: this is where read-only becomes real. `authenticate()` computes `readOnly`, but Hocuspocus
// does NOT read it from the hook's RETURN value: the return is merged into `context` only, while the
// Connection is built from `hookPayload.connection.readOnly` (ClientConnection.createConnection) and
// MessageReceiver consults `connection.readOnly` when a SyncStep2/Update message arrives. Assigning
// the payload's connection config is therefore the ONLY lever that refuses a write. Before #811 the
// value was merely returned, so every connection was writable and a view-capability guest, a
// view-only member, and a public-wildcard reader could all persist edits into pages.ydoc.
import type { onAuthenticatePayload } from "@hocuspocus/server";
import type IORedis from "ioredis";
import { authenticate, type AuthResult } from "./authenticate.js";
import { readConnectCaps, guestConnectRateAllowed } from "./abuse-rate.js"; // #328 / ADR-140 increment 2

export function makeOnAuthenticate(rateValkey: IORedis) {
  return async function onAuthenticate(payload: onAuthenticatePayload): Promise<AuthResult> {
    const result = await authenticate({ token: payload.token, documentName: payload.documentName });
    // #328 / ADR-140 increment 2: guest connect/reconnect rate cap (per share link + per #331 session —
    // never raw IP). AFTER authenticate so an unauthorized token never reaches a bucket (no pre-auth
    // probe), and members are never capped. Defaults (NULL) short-circuit with zero Valkey I/O. This is
    // the ADR-140 I4 seam: the share-link id and the session id are both in hand exactly here.
    if (result.principal.kind === "guest") {
      const caps = await readConnectCaps(result.principal.tenantId);
      const allowed = await guestConnectRateAllowed(rateValkey, caps, {
        tenantId: result.principal.tenantId,
        shareLinkId: result.principal.shareLinkId,
        anonId: result.principal.anonId,
      });
      if (!allowed) throw new Error("forbidden: connection rate limited"); // static reason — no content/limit echo
    }
    // #811: the enforcement. The hook payload's `connection` is the SAME object Hocuspocus hands to
    // `new Connection(...)`, so this assignment (not the returned `readOnly`) is what makes the server
    // drop a read-only client's updates. Assigned unconditionally — never `if (result.readOnly)` — so a
    // writable principal is not left riding a default that a future refactor could flip.
    payload.connection.readOnly = result.readOnly;
    return result;
  };
}
