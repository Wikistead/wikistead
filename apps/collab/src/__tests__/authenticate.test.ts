// Integration tests for the collab join point (real OpenFGA). Covers the new
// member-collab-token path (P1.1 C4) plus the dev bypass. The token asserts
// identity; authority is re-derived from OpenFGA per document.
import { describe, it, expect, afterAll } from "vitest";
import { mintMemberCollabToken, mintGuestToken } from "@wikistead/auth";
import type { Capability } from "@wikistead/types";
import { fgaClient, writeTuples, deleteTuples, deleteObjectTuples } from "@wikistead/authz";
import { beforeAll } from "vitest";
import { authenticate, parseDocName } from "../authenticate.js";

const cfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };
// #417: a SCRATCH page/space owned by this suite — the tests used to ride the shared dev
// `page:demo`, so any residue on it (e.g. a stale private-marker pair from manual testing)
// turned the whole suite red for every session (#279's scratch-fixture rule, applied here).
const PAGE = "collab-authz-417";
const SUITE_SPACE = "collab-authz-417-space";
const DOC = `t:tenant_dev:p:${PAGE}`;
const SUITE_TUPLES = [
  { user: "tenant:tenant_dev", relation: "tenant", object: `space:${SUITE_SPACE}` },
  { user: "user:dev-user", relation: "manager", object: `space:${SUITE_SPACE}` }, // mirrors demo: manager => writable member
  { user: `space:${SUITE_SPACE}`, relation: "space", object: `page:${PAGE}` },
  { user: "user:*", relation: "published", object: `page:${PAGE}` },
  { user: "share_link:*", relation: "published", object: `page:${PAGE}` },
];
beforeAll(async () => {
  for (const t of SUITE_TUPLES) await deleteTuples(fgaClient, [t]).catch(() => {}); // idempotent re-run
  await writeTuples(fgaClient, SUITE_TUPLES);
});
afterAll(async () => {
  await deleteObjectTuples(fgaClient, `page:${PAGE}`).catch(() => {});
  await deleteObjectTuples(fgaClient, `space:${SUITE_SPACE}`).catch(() => {});
});

describe("collab authenticate — member collab token", () => {
  it("admits a member with access; authority comes from OpenFGA, not the token", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: "dev-user", groups: [] });
    const r = await authenticate({ token, documentName: DOC });
    expect(r.principal).toMatchObject({ kind: "member", tenantId: "tenant_dev", userId: "dev-user" });
    expect(r.readOnly).toBe(false);
  });

  it("rejects a token whose tenant ≠ the document's tenant (cross-tenant)", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_acme", sub: "dev-user", groups: [] });
    await expect(authenticate({ token, documentName: DOC })).rejects.toThrow(/tenant mismatch/);
  });

  it("rejects a validly-signed token for a subject with NO FGA access (identity ≠ authority)", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: "collab-stranger-c4", groups: [] });
    await expect(authenticate({ token, documentName: DOC })).rejects.toThrow(/no access/);
  });

  it("dev-token bypass still works (dev only)", async () => {
    const r = await authenticate({ token: "dev-token", documentName: DOC });
    expect(r.principal).toMatchObject({ kind: "member", userId: "dev-user" });
  });

  // P3 two-layer edit defense (the fortress): a member with ONLY view authority
  // is admitted read-only, so even if the client forges the Edit button, the
  // collab connection rejects writes server-side. Authority is FGA, not the UI.
  it("admits a view-only member as readOnly (server is the write fortress)", async () => {
    const VIEWER = "collab-viewonly-p3";
    // #471: membership admits them to the tenant; the page grant decides what they may do there
    await writeTuples(fgaClient, [
      { user: `user:${VIEWER}`, relation: "view_direct", object: `page:${PAGE}` },
      { user: `user:${VIEWER}`, relation: "member", object: "tenant:tenant_dev" },
    ]);
    try {
      const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: VIEWER, groups: [] });
      const r = await authenticate({ token, documentName: DOC });
      expect(r.principal).toMatchObject({ kind: "member", userId: VIEWER });
      expect(r.readOnly).toBe(true); // view ⇒ read-only ⇒ Hocuspocus rejects writes
    } finally {
      await deleteTuples(fgaClient, [
        { user: `user:${VIEWER}`, relation: "view_direct", object: `page:${PAGE}` },
        { user: `user:${VIEWER}`, relation: "member", object: "tenant:tenant_dev" },
      ]).catch(() => {});
    }
  });
});

// #106 / ADR-028: active disconnect severs connected guests on revoke, but the disconnect is
// only safe because a severed guest CANNOT rejoin. Revocation = deleting the share_link tuple;
// onAuthenticate re-derives authority from FGA on every connect, so the same (still
// structurally valid) token is rejected after revoke. Without this, reconnect-after-disconnect
// would make the active disconnect pointless.
describe("collab authenticate — guest token, reconnect blocked after revoke", () => {
  const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };
  const LINK = "revoke-test-link-106";
  const tuple = { user: `share_link:${LINK}`, relation: "view_direct", object: `page:${PAGE}` }; // #100 Option B: view is computed → grant view_base

  it("admits a guest while the tuple exists; rejects the SAME token after the tuple is deleted", async () => {
    await writeTuples(fgaClient, [tuple]);
    const token = await mintGuestToken(guestCfg, {
      tenantId: "tenant_dev", shareLinkId: LINK, resource: { type: "page", id: PAGE }, capability: "view",
    });
    try {
      const ok = await authenticate({ token, documentName: DOC });
      expect(ok.principal).toMatchObject({ kind: "guest", shareLinkId: LINK });
      expect(ok.readOnly).toBe(true); // a view guest joins read-only (the write fortress)

      // Revoke (the active-disconnect authority). A reconnect with the same token must fail.
      await deleteTuples(fgaClient, [tuple]);
      await expect(authenticate({ token, documentName: DOC })).rejects.toThrow(/denied|expired|forbidden/);
    } finally {
      await deleteTuples(fgaClient, [tuple]).catch(() => {});
    }
  });
});

// The guest capability → readOnly mapping (apps/collab invariant: "a view-capability guest can
// NOT edit; readOnly is enforced"). Edit guests write; view/comment guests are readOnly; and a
// token that CLAIMS edit without edit authority is denied (intent ≠ authority — the write fortress).
describe("collab authenticate — guest capability ⇒ readOnly (write fortress)", () => {
  const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };
  const LINK = "cap-link-collab";
  const editTuple = { user: `share_link:${LINK}`, relation: "edit_direct", object: `page:${PAGE}` };
  const viewTuple = { user: `share_link:${LINK}`, relation: "view_direct", object: `page:${PAGE}` };
  const mint = (capability: Capability) => mintGuestToken(guestCfg, {
    tenantId: "tenant_dev", shareLinkId: LINK, resource: { type: "page", id: PAGE }, capability,
  });
  afterAll(async () => { for (const t of [editTuple, viewTuple]) await deleteTuples(fgaClient, [t]).catch(() => {}); });

  it("an EDIT guest (edit authority) joins WRITABLE (readOnly:false)", async () => {
    await writeTuples(fgaClient, [editTuple]);
    const r = await authenticate({ token: await mint("edit"), documentName: DOC });
    expect(r.principal).toMatchObject({ kind: "guest", capability: "edit" });
    expect(r.readOnly).toBe(false);
    await deleteTuples(fgaClient, [editTuple]).catch(() => {});
  });

  it("a COMMENT guest joins read-only (comments go via HTTP, never the doc)", async () => {
    // #100 Option B: a comment guest has view_base@share_link (+ space comment_open, checked over HTTP,
    // not here). The collab layer only distinguishes edit vs non-edit → it checks 'view' (satisfied by
    // view_base) and joins the comment guest read-only. comment@share_link is not directly writable now.
    await writeTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: "view_direct", object: `page:${PAGE}` }]);
    const r = await authenticate({ token: await mint("comment"), documentName: DOC });
    expect(r.readOnly).toBe(true); // capability !== "edit" ⇒ readOnly
    await deleteTuples(fgaClient, [{ user: `share_link:${LINK}`, relation: "view_direct", object: `page:${PAGE}` }]).catch(() => {});
  });

  it("a token that CLAIMS edit but has only VIEW authority is DENIED (intent ≠ authority)", async () => {
    await writeTuples(fgaClient, [viewTuple]); // only view authority
    // The token forges capability:"edit" → the FGA check is for 'edit' → fails → rejected.
    await expect(authenticate({ token: await mint("edit"), documentName: DOC })).rejects.toThrow(/denied|expired|forbidden|access/);
    // …and the same link as a proper VIEW guest is admitted read-only (authority honoured).
    const r = await authenticate({ token: await mint("view"), documentName: DOC });
    expect(r.readOnly).toBe(true);
    await deleteTuples(fgaClient, [viewTuple]).catch(() => {});
  });
});

// #104 / ADR-038: a SPACE share-link token admits the guest to ANY published page that
// inherits view from the space — not just one page — and never to a page outside the space
// or after revoke. A VIEW link stays view-only; the EDIT link is #812's block below.
describe("collab authenticate — space share-link token (#104)", () => {
  const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };
  const SPACE = "sl-space-104";
  const LINK = "sl-link-104";
  const spaceGrant = { user: `share_link:${LINK}`, relation: "viewer", object: `space:${SPACE}` };
  const pageInSpace = { user: `space:${SPACE}`, relation: "space", object: `page:${PAGE}` }; // demo ∈ SPACE

  it("admits a space-token guest to a page in the space (read-only), rejects out-of-space + post-revoke", async () => {
    // Clean any leftover INDIVIDUALLY (a batch delete aborts if one tuple is already gone).
    for (const t of [spaceGrant, pageInSpace]) await deleteTuples(fgaClient, [t]).catch(() => {});
    await writeTuples(fgaClient, [spaceGrant, pageInSpace]); // space link + demo inherits from SPACE
    const token = await mintGuestToken(guestCfg, {
      tenantId: "tenant_dev", shareLinkId: LINK, resource: { type: "space", id: SPACE }, capability: "view",
    });
    try {
      // a page in the space → admitted, view-only (no page-id match needed for a space token)
      const r = await authenticate({ token, documentName: DOC }); // DOC = t:tenant_dev:p:demo
      expect(r.principal).toMatchObject({ kind: "guest", shareLinkId: LINK });
      expect(r.readOnly).toBe(true); // a space VIEW link is read-only (its capability, not its kind)

      // a page NOT in the space → rejected (inheritance doesn't reach it)
      await expect(authenticate({ token, documentName: "t:tenant_dev:p:not-in-space-xyz" }))
        .rejects.toThrow(/denied|expired|forbidden/);

      // revoke = delete the one space tuple → the same token is rejected on reconnect
      await deleteTuples(fgaClient, [spaceGrant]);
      await expect(authenticate({ token, documentName: DOC })).rejects.toThrow(/denied|expired|forbidden/);
    } finally {
      // Individually — spaceGrant was already deleted by the revoke step above.
      for (const t of [spaceGrant, pageInSpace]) await deleteTuples(fgaClient, [t]).catch(() => {});
    }
  });
});

// #812 / #274 / ADR-135: the space EDIT link. collab used to overwrite a space token's capability with
// "view" — a fossil of ADR-038, when `space#editor` had no share_link type at all. Once #811 made
// read-only real, that line would have demoted every anonymous-wiki editor to a reader. The token's
// capability is now honoured for a space link exactly as for a page link, and OpenFGA (editor from
// space) remains the authority: forging `edit` on a view-only link is refused, not silently downgraded.
describe("collab authenticate — space EDIT share-link token (#812)", () => {
  const guestCfg = { secret: process.env.GUEST_TOKEN_SECRET!, ttlSeconds: 300 };
  const SPACE = "sl-space-812";
  const EDIT_LINK = "sl-editlink-812";
  const VIEW_LINK = "sl-viewlink-812";
  const editGrant = { user: `share_link:${EDIT_LINK}`, relation: "editor", object: `space:${SPACE}` };
  const viewGrant = { user: `share_link:${VIEW_LINK}`, relation: "viewer", object: `space:${SPACE}` };
  const pageInSpace = { user: `space:${SPACE}`, relation: "space", object: `page:${PAGE}` };
  const all = [editGrant, viewGrant, pageInSpace];
  const mint = (shareLinkId: string, capability: Capability) => mintGuestToken(guestCfg, {
    tenantId: "tenant_dev", shareLinkId, resource: { type: "space", id: SPACE }, capability,
  });

  beforeAll(async () => {
    for (const t of all) await deleteTuples(fgaClient, [t]).catch(() => {});
    await writeTuples(fgaClient, all);
  });
  afterAll(async () => { for (const t of all) await deleteTuples(fgaClient, [t]).catch(() => {}); });

  it("admits a space EDIT guest WRITABLE (edit inherited from space#editor)", async () => {
    const r = await authenticate({ token: await mint(EDIT_LINK, "edit"), documentName: DOC });
    expect(r.principal).toMatchObject({ kind: "guest", shareLinkId: EDIT_LINK, capability: "edit" });
    expect(r.readOnly).toBe(false);
  });

  it("lets a space EDIT guest into the ephemeral Excalidraw room (#811 ruling 3)", async () => {
    const r = await authenticate({ token: await mint(EDIT_LINK, "edit"), documentName: `${DOC}:x:anchor-812` });
    expect(r.readOnly).toBe(false);
  });

  it("refuses a space token that CLAIMS edit on a VIEW-only link (intent is not authority)", async () => {
    await expect(authenticate({ token: await mint(VIEW_LINK, "edit"), documentName: DOC }))
      .rejects.toThrow(/denied|expired|forbidden/);
  });

  it("refuses a space VIEW guest the ephemeral room (co-editing a drawing requires edit)", async () => {
    await expect(authenticate({ token: await mint(VIEW_LINK, "view"), documentName: `${DOC}:x:anchor-812` }))
      .rejects.toThrow(/denied|expired|forbidden|edit/);
  });

  it("still refuses a space EDIT guest a page OUTSIDE the space (the space is the boundary)", async () => {
    await expect(authenticate({ token: await mint(EDIT_LINK, "edit"), documentName: "t:tenant_dev:p:not-in-space-812" }))
      .rejects.toThrow(/denied|expired|forbidden/);
  });

  it("refuses the same EDIT token after revoke (deleting the one space tuple)", async () => {
    await deleteTuples(fgaClient, [editGrant]);
    try {
      await expect(authenticate({ token: await mint(EDIT_LINK, "edit"), documentName: DOC }))
        .rejects.toThrow(/denied|expired|forbidden/);
    } finally {
      await writeTuples(fgaClient, [editGrant]).catch(() => {});
    }
  });
});

// #92 / ADR-093: the EPHEMERAL Excalidraw room (t:<tenant>:p:<pageId>:x:<anchor>). Co-editing a drawing
// is editing the page → the room REQUIRES edit (a view-only principal is denied), reuses the page's FGA
// authority, and enforces tenant isolation exactly like the normal room.
describe("collab authenticate — ephemeral Excalidraw room (#92)", () => {
  const EX = `t:tenant_dev:p:${PAGE}:x:anchor-1`; // ephemeral room for the scratch page's excalidraw macro
  const VO = "collab-exview-92";
  const voTuple = { user: `user:${VO}`, relation: "view_direct", object: `page:${PAGE}` };

  it("admits an EDIT member (co-editing = edit; dev-user manages the suite space)", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: "dev-user", groups: [] });
    const r = await authenticate({ token, documentName: EX });
    expect(r.readOnly).toBe(false);
  });

  it("DENIES a view-only member (the ephemeral room requires edit)", async () => {
    await writeTuples(fgaClient, [voTuple]);
    try {
      const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_dev", sub: VO, groups: [] });
      await expect(authenticate({ token, documentName: EX })).rejects.toThrow(/edit/);
    } finally {
      await deleteTuples(fgaClient, [voTuple]).catch(() => {});
    }
  });

  it("enforces tenant isolation for the ephemeral room (cross-tenant rejected)", async () => {
    const token = await mintMemberCollabToken(cfg, { tenantId: "tenant_acme", sub: "dev-user", groups: [] });
    await expect(authenticate({ token, documentName: EX })).rejects.toThrow(/tenant mismatch/);
  });
});

// #92 / ADR-093: parseDocName's `ephemeral` discriminant is the foundation of BOTH the auth gate
// (ephemeral ⇒ requires edit) and the persistence skip (ephemeral ⇒ fetch null / store no-op). It must
// tell a normal page room from an ephemeral one and reject garbage — colon-free uuids make `:x:`
// unambiguous, and the ephemeral pattern is matched before the page pattern's greedy tail.
describe("parseDocName (ephemeral discriminant, #92)", () => {
  it("parses a normal page room (ephemeral=false)", () => {
    expect(parseDocName("t:tenant_dev:p:demo")).toEqual({ tenantId: "tenant_dev", pageId: "demo", ephemeral: false });
  });
  it("parses an ephemeral room to the SAME page (ephemeral=true, anchor ignored)", () => {
    expect(parseDocName("t:tenant_dev:p:demo:x:anchor-1")).toEqual({ tenantId: "tenant_dev", pageId: "demo", ephemeral: true });
  });
  it("does not misread a page room as ephemeral, nor an ephemeral room as a page with a weird id", () => {
    expect(parseDocName("t:acme:p:11111111-2222-3333").ephemeral).toBe(false);
    const e = parseDocName("t:acme:p:11111111-2222-3333:x:z9");
    expect(e).toEqual({ tenantId: "acme", pageId: "11111111-2222-3333", ephemeral: true }); // page id intact
  });
  it("throws on a malformed name (never silently admits garbage)", () => {
    expect(() => parseDocName("not-a-doc")).toThrow(/bad document name/);
    expect(() => parseDocName("t:x:q:y")).toThrow(/bad document name/);
  });
});
