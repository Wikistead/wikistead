import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";
import { openScratch, enterEdit, paneText, sleep, API } from "../helpers";

// Mint an MCP access token the same way @wikistead/auth does (HS256, header typ "mcp+jwt") without importing the
// package (the e2e workspace has no built dist of it) — a dependency-free HMAC JWT the server verifies.
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function mintMcpToken(secret: string, claims: object): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "mcp+jwt" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + 300 }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

// #369 / ADR-144: the MCP `edit_body` tool writes a page body into the CANONICAL single Y.Text via the collab
// tier (never a published_md overwrite, never a second CRDT). The binding anti-test is NO FORK: an edit_body
// call must appear in a LIVE editor session on the same page (the collab pod applied it as a Y.Text op and
// broadcast it), and it edits the DRAFT (visible to editors immediately, not the published page). Runs against
// the real e2e stack (server + collab + Valkey + OpenFGA).
//
// The MCP access token is HS256-signed with the same GUEST_TOKEN_SECRET the server verifies (mcp+jwt). Host
// the API origin (helpers.API) resolves slug "dev" → tenant_dev, so we hit the server's /mcp directly (a public endpoint,
// tenant-by-Host). dev-token (the browser session) and the token's sub are both `dev-user`, the page creator.
const SECRET = /GUEST_TOKEN_SECRET=(.+)/.exec(
  readFileSync(fileURLToPath(new URL("../../../.env.e2e", import.meta.url)), "utf8"),
)![1]!.trim();
const MCP_URL = `${API}/mcp`;

async function mcp(sub: string, name: string, args: object) {
  const token = mintMcpToken(SECRET, { tenantId: "tenant_dev", sub, scopes: ["read", "write"], groups: [] });
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return (await res.json()) as { result?: { content?: { text: string }[]; isError?: boolean } };
}

test("#369 edit_body append lands in the LIVE editor session (collab-mediated, no fork)", async ({ page }) => {
  const id = await openScratch(page, `mcp-edit-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Doc\n\nfirst line\n");
  await sleep(500); // let the editor sync the initial content to the collab pod

  const r = await mcp("dev-user", "edit_body", { pageId: id, op: "append", content: "APPENDED_BY_MCP_369" });
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();
  expect(r.result?.content?.[0]?.text).toContain("appended");

  // The collab pod applied the Y.Text op to the live doc and broadcast it → the open editor session shows it.
  await expect
    .poll(async () => paneText(page, "preview"), { timeout: 10_000 })
    .toContain("APPENDED_BY_MCP_369");
  // The original content is preserved (append, not replace) — no fork/overwrite of the concurrent session.
  expect(await paneText(page, "preview")).toContain("first line");
});

test("#369 edit_body replace_section rewrites one section in the live draft", async ({ page }) => {
  const id = await openScratch(page, `mcp-sec-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Top\n\nintro\n\n## Notes\n\nold notes\n");
  await sleep(500);

  const r = await mcp("dev-user", "edit_body", { pageId: id, op: "replace_section", heading: "Notes", content: "## Notes\n\nNEW_NOTES_369" });
  expect(r.result?.isError, JSON.stringify(r.result)).toBeFalsy();

  await expect.poll(async () => paneText(page, "preview"), { timeout: 10_000 }).toContain("NEW_NOTES_369");
  const text = await paneText(page, "preview");
  expect(text).not.toContain("old notes"); // the section body was replaced
  expect(text).toContain("intro"); // content outside the section is untouched
});

test("#369 edit_body from a NON-editor is a uniform 'cannot edit that page' (existence-hiding)", async ({ page }) => {
  const id = await openScratch(page, `mcp-authz-${Date.now()}`);
  await sleep(200);
  // `stranger` is a MEMBER of the tenant (seeded in fixtures.ts) with no grant on this freshly-created
  // page (creator-only draft) → FGA edit denies. #471 / ADR-176: membership has to be real, or the
  // refusal comes from the tenant binding one layer earlier and this stops pinning the message.
  const r = await mcp("stranger", "edit_body", { pageId: id, op: "append", content: "x" });
  expect(r.result?.isError).toBe(true);
  expect(r.result?.content?.[0]?.text).toBe("error: cannot edit that page");
});
