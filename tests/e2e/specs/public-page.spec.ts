import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterEdit, openScratch, sleep } from "../helpers";

// #227 / ADR-030: the PUBLIC page view (/pub/:pageId) — the frontend consumer of GET /public/pages/:id.
// An ANONYMOUS browser context (no session/cookies) renders a published-public page's title + sanitized
// body; a non-public page shows the not-found screen (existence hidden). The make-public step writes the
// FGA tuple (view_base@user:*) directly against the e2e OpenFGA — the same idiom the server tests use
// (there is no public-toggle HTTP route yet).

const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
const STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
const MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();
const FGA = "http://localhost:8090";

async function makePublic(pageId: string) {
  const res = await fetch(`${FGA}/stores/${STORE}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      writes: { tuple_keys: [{ user: "user:*", relation: "view_base", object: `page:${pageId}` }] },
      authorization_model_id: MODEL,
    }),
  });
  if (!res.ok) throw new Error(`fga write failed: ${res.status} ${await res.text()}`);
}

test("#227: an anonymous visitor renders a public page at /pub/:id (title + sanitized body)", async ({ browser }) => {
  // 1. Authed context: create + publish a page.
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-view");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("# Public Heading\n\npublic body text <script>alert(1)</script>\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800); // publish flush
  await makePublic(id);

  // 2. FRESH anonymous context (no cookies/session) renders it.
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-title")).toBeVisible();
  const body = anon.getByTestId("public-body");
  await expect(body.locator("h1")).toHaveText("Public Heading"); // markdown rendered
  await expect(body).toContainText("public body text");
  // XSS: the raw <script> degrades to escaped text — never a live element.
  expect(await body.locator("script").count()).toBe(0);
  await expect(body).toContainText("<script>alert(1)</script>");
});

test("#227: a NON-public page shows not-found to an anonymous visitor (existence hidden)", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-hidden");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("secret\n");
  await sleep(300);
  await authed.getByTestId("publish-page").click();
  await sleep(600);
  // published but NOT public → anonymous 404 → not-found screen
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-not-found")).toBeVisible();
  expect(await anon.getByTestId("public-title").count()).toBe(0);
});
