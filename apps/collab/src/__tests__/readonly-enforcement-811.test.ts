// #811 / #812: the write fortress, measured on a REAL server instead of on a return value.
//
// The bug this file exists for: `authenticate()` had always computed `readOnly` correctly, and
// authenticate.test.ts had always asserted that computation — but nothing carried the verdict into
// Hocuspocus. The hook's return value is merged into `context` and nowhere else; `Connection` is
// built from `hookPayload.connection.readOnly`. So every guest, view-only member and public reader
// could write to the live document, and a suite full of green `expect(r.readOnly).toBe(true)`
// assertions said nothing about it (break-check-vacuous: the assertions survive the enforcement
// being deleted).
//
// So this suite drives the SHIPPED hook (`makeOnAuthenticate`, the same function index.ts installs)
// on a real Hocuspocus listening on an ephemeral port, connects a real client, types into the
// client's Y.Doc, and then asks the SERVER's document what it holds. A read-only principal's text
// must never appear there; a writable principal's must (the green path — a fortress that refuses
// everyone is not a fortress).
//
// No Database extension is wired: persistence stores whatever the server document holds, so the
// server document IS the thing to measure. The FGA store is the real one (the isolated stack).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as Y from "yjs";
import IORedis from "ioredis";
import { Hocuspocus } from "@hocuspocus/server";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { mintGuestToken, mintMemberCollabToken } from "@wikistead/auth";
import { fgaClient, writeTuples, deleteTuples, deleteObjectTuples } from "@wikistead/authz";
import { makeOnAuthenticate } from "../on-authenticate.js";

const cfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };

// A scratch page + space owned by this suite (#417's rule: never ride the shared dev fixtures, whose
// residue turns the suite red for every session).
const PAGE = "collab-ro-811";
const SPACE = "collab-ro-811-space";
const DOC = `t:tenant_dev:p:${PAGE}`;
const EPHEMERAL_DOC = `${DOC}:x:anchor-811`;

const SUITE_TUPLES = [
  { user: "tenant:tenant_dev", relation: "tenant", object: `space:${SPACE}` },
  { user: "user:dev-user", relation: "manager", object: `space:${SPACE}` },
  { user: `space:${SPACE}`, relation: "space", object: `page:${PAGE}` },
  // The folder-cascade gate: space inheritance only reaches a PUBLISHED page (#218 / ADR-103).
  { user: "user:*", relation: "published", object: `page:${PAGE}` },
  { user: "share_link:*", relation: "published", object: `page:${PAGE}` },
];

// The rate-limit client the shipped hook takes. Caps default to NULL ⇒ Infinity ⇒ `bumpRateBucket`
// short-circuits with no Valkey round trip, so `lazyConnect` never opens a socket. Declaring it this
// way keeps the suite honest: if the limiter ever started doing I/O on the default path, this would
// fail loudly rather than quietly talking to a shared Valkey.
const rateValkey = new IORedis(process.env.VALKEY_URL ?? "redis://localhost:6379", { lazyConnect: true });

let server: Hocuspocus;
let port: number;

beforeAll(async () => {
  for (const t of SUITE_TUPLES) await deleteTuples(fgaClient, [t]).catch(() => {}); // idempotent re-run
  await writeTuples(fgaClient, SUITE_TUPLES);

  server = new Hocuspocus({
    quiet: true,
    stopOnSignals: false, // a test server must not install process-wide signal handlers
    // THE POINT OF THIS SUITE: the hook under test is the one index.ts ships, not a copy of it.
    onAuthenticate: makeOnAuthenticate(rateValkey),
  });
  // Port 0 = the OS picks a free one, so parallel sessions' runs never collide (the isolated stack
  // gives each session its own DB/FGA, but a hardcoded port would still be shared machine-wide).
  await server.listen(0);
  port = (server.server!.httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  await server?.destroy().catch(() => {});
  await deleteObjectTuples(fgaClient, `page:${PAGE}`).catch(() => {});
  await deleteObjectTuples(fgaClient, `space:${SPACE}`).catch(() => {});
  rateValkey.disconnect();
});

/** The server's own copy of the room — what persistence would store, and so what we measure. */
function serverText(documentName: string): string {
  return server.documents.get(documentName)?.getText("content").toString() ?? "";
}

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

interface Session { doc: Y.Doc; provider: HocuspocusProvider; close: () => void }

/** Connect a real client and wait for the initial sync (or an authentication refusal). */
async function connect(token: string, documentName: string): Promise<Session> {
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: `ws://127.0.0.1:${port}`,
    name: documentName,
    token,
    document: doc,
    // The client must not paper over a refused update by resending it on a timer — that would make a
    // "did the write land" measurement depend on how long we happened to wait.
    forceSyncInterval: false,
    preserveConnection: false,
  });
  let refused = false;
  provider.on("authenticationFailed", () => { refused = true; });
  const ok = await until(() => provider.isSynced || refused, 8000);
  if (!ok) throw new Error(`client never synced to ${documentName}`);
  if (refused) throw new Error("forbidden: authentication failed");
  return { doc, provider, close: () => { provider.destroy(); } };
}

/**
 * Type into the CLIENT's document, then report what reached the SERVER's. The wait is generous on the
 * refusal path on purpose: "the text is still absent" must not be an artefact of measuring too early,
 * so we give a would-be write far longer than the writable path needs (measured below in the same run).
 */
async function typeAndReadBack(s: Session, documentName: string, text: string): Promise<string> {
  s.doc.getText("content").insert(0, text);
  await until(() => serverText(documentName).includes(text), 3000);
  return serverText(documentName);
}

describe("#811: a read-only principal's writes never reach the server document", () => {
  const LINK = "ro-811-view-link";
  const viewTuple = { user: `share_link:${LINK}`, relation: "view_direct", object: `page:${PAGE}` };

  afterAll(async () => { await deleteTuples(fgaClient, [viewTuple]).catch(() => {}); });

  it("a VIEW share-link guest is admitted, and the document is unchanged by their edit", async () => {
    await writeTuples(fgaClient, [viewTuple]);
    const token = await mintGuestToken(cfg, {
      tenantId: "tenant_dev", shareLinkId: LINK, resource: { type: "page", id: PAGE }, capability: "view",
    });
    const s = await connect(token, DOC); // admitted — a view guest reads the live doc
    try {
      expect(await typeAndReadBack(s, DOC, "guest-view-must-not-persist")).toBe("");
    } finally { s.close(); }
  });

  it("a VIEW-ONLY member is admitted, and the document is unchanged by their edit", async () => {
    const VIEWER = "collab-ro-811-viewer";
    const tuples = [
      { user: `user:${VIEWER}`, relation: "view_direct", object: `page:${PAGE}` },
      { user: `user:${VIEWER}`, relation: "member", object: "tenant:tenant_dev" },
    ];
    await writeTuples(fgaClient, tuples);
    try {
      const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: VIEWER, groups: [] });
      const s = await connect(token, DOC);
      try {
        expect(await typeAndReadBack(s, DOC, "member-view-must-not-persist")).toBe("");
      } finally { s.close(); }
    } finally {
      await deleteTuples(fgaClient, tuples).catch(() => {});
    }
  });

  it("an EDIT member DOES write (the fortress refuses the right people, not everyone)", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: "dev-user", groups: [] });
    const s = await connect(token, DOC);
    try {
      expect(await typeAndReadBack(s, DOC, "editor-writes")).toContain("editor-writes");
    } finally { s.close(); }
  });
});

// #812: the space EDIT link is the anonymous-wiki face (#274 / ADR-135). collab forced every space
// token to "view", so once #811 made read-only real this guest would have been silently demoted —
// the demo's headline scenario, stopped. The two tickets land together for exactly this reason, and
// this suite measures the pair: the edit link writes, the view link does not.
describe("#812: a space EDIT share-link guest edits; a space VIEW guest does not", () => {
  const EDIT_LINK = "ro-812-space-edit-link";
  const VIEW_LINK = "ro-812-space-view-link";
  const editTuple = { user: `share_link:${EDIT_LINK}`, relation: "editor", object: `space:${SPACE}` };
  const viewTuple = { user: `share_link:${VIEW_LINK}`, relation: "viewer", object: `space:${SPACE}` };

  beforeAll(async () => {
    for (const t of [editTuple, viewTuple]) await deleteTuples(fgaClient, [t]).catch(() => {});
    await writeTuples(fgaClient, [editTuple, viewTuple]);
  });
  afterAll(async () => {
    for (const t of [editTuple, viewTuple]) await deleteTuples(fgaClient, [t]).catch(() => {});
  });

  const mint = (shareLinkId: string, capability: "view" | "edit") =>
    mintGuestToken(cfg, { tenantId: "tenant_dev", shareLinkId, resource: { type: "space", id: SPACE }, capability });

  it("the space EDIT guest's text reaches the server document", async () => {
    const s = await connect(await mint(EDIT_LINK, "edit"), DOC);
    try {
      expect(await typeAndReadBack(s, DOC, "space-edit-guest-writes")).toContain("space-edit-guest-writes");
    } finally { s.close(); }
  });

  it("the space VIEW guest is admitted read-only (a view link is still a view link)", async () => {
    const s = await connect(await mint(VIEW_LINK, "view"), DOC);
    // Captured AFTER the join, never before: with no Database extension a room is unloaded once its
    // last connection drops, so a baseline taken earlier describes a document this connection never saw.
    const before = serverText(DOC);
    try {
      expect(await typeAndReadBack(s, DOC, "space-view-guest-must-not-persist")).toBe(before);
    } finally { s.close(); }
  });

  // #811 ruling 3 (2026-08-21): a space EDIT link opens the ephemeral Excalidraw room too — the same
  // co-editing power a page edit link has. The room requires `edit`, so a space VIEW guest is refused
  // outright (never admitted read-only: joining a drawing room you cannot draw in is not a feature).
  it("the space EDIT guest may open the ephemeral Excalidraw room; the VIEW guest is refused", async () => {
    const s = await connect(await mint(EDIT_LINK, "edit"), EPHEMERAL_DOC);
    try {
      expect(await typeAndReadBack(s, EPHEMERAL_DOC, "space-edit-guest-draws")).toContain("space-edit-guest-draws");
    } finally { s.close(); }
    await expect(connect(await mint(VIEW_LINK, "view"), EPHEMERAL_DOC)).rejects.toThrow(/forbidden/);
  });
});
