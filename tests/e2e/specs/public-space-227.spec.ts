import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterEdit, FGA, openScratch, setPublicSurface, sleep } from "../helpers";

// #227 / ADR-030 (option b): the anonymous read-only PUBLIC reader-chrome for a public space. An anonymous
// browser context (no session) browses a public space in the app shell's sidebar (its published+public page
// tree) and reads a page in the content area — with NO member chrome. The space is made public by writing
// space:S#viewer@user:* directly against the e2e OpenFGA (no public-toggle route yet — #253).
const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
const STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
const MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();

async function fgaWrite(tuple: { user: string; relation: string; object: string }) {
  const res = await fetch(`${FGA}/stores/${STORE}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writes: { tuple_keys: [tuple] }, authorization_model_id: MODEL }),
  });
  if (!res.ok) throw new Error(`fga write failed: ${res.status} ${await res.text()}`);
}
async function fgaDelete(tuple: { user: string; relation: string; object: string }) {
  await fetch(`${FGA}/stores/${STORE}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deletes: { tuple_keys: [tuple] }, authorization_model_id: MODEL }),
  }).catch(() => {});
}

// Restore demo_space to NON-public after this file — making it public is shared e2e-FGA state that would
// otherwise leak a "non-public demo_space page" assumption in other specs (e.g. public-page.spec).
test.afterAll(async () => {
  await fgaDelete({ user: "user:*", relation: "viewer", object: "space:demo_space" });
});

test("#227: an anonymous visitor browses a public space via the sidebar reader-chrome, no member chrome", async ({ browser }) => {
  // Authed: create + publish a page in demo_space (publish writes page#space → anon-viewable in a public space).
  const authed = await (await browser.newContext()).newPage();
  const title = `pub-space-${Date.now()}`; // this is the page TITLE the sidebar tree shows (not the body H1)
  await openScratch(authed, title);
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("# Public space page\n\nvisible to anyone\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  // Make demo_space a PUBLIC space (anonymous viewer).
  await fgaWrite({ user: "user:*", relation: "viewer", object: "space:demo_space" }).catch(() => {}); // idempotent (may already be public from a prior run)
  await setPublicSurface(authed, true); // #253: the tenant parent switch must be ON for the public surface

  // Anonymous context (no cookies/session) → the public reader-chrome.
  const anon = await (await browser.newContext()).newPage();
  await anon.goto("/pub/space/demo_space");
  // #227 the public reader renders the SAME member components — the "sidebar" frame + PageTree ("tree-page"
  // rows), not a public-only reimplementation. Assert the shared testids (there is no more public-sidebar/
  // public-tree-page).
  await expect(anon.getByTestId("sidebar")).toBeVisible({ timeout: 10000 });
  await expect(anon.getByTestId("page-tree")).toBeVisible({ timeout: 10000 });
  const row = anon.getByTestId("tree-page").filter({ hasText: title }).first();
  await expect(row).toBeVisible({ timeout: 10000 });

  // NO member chrome: no user menu / search / new-page / row actions for an anonymous public visitor (canEdit=false).
  await expect(anon.getByTestId("user-menu")).toHaveCount(0);
  await expect(anon.getByTestId("new-page")).toHaveCount(0);
  await expect(anon.getByTestId("page-actions")).toHaveCount(0);

  // Clicking a page renders its sanitized body in the content area.
  await row.click();
  await expect(anon.getByTestId("public-body").locator(".cm-lp-h1")).toContainText("Public space page", { timeout: 10000 }); // #319: CM heading line
  await expect(anon.getByTestId("public-body")).toContainText("visible to anyone");
});
