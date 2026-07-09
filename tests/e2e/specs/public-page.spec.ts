import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterEdit, openScratch, setPublicSurface, sleep } from "../helpers";

// #227 / ADR-030: the PUBLIC page view /pub/:pageId) — the frontend consumer of GET /public/pages/:id.
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
  await setPublicSurface(authed, true); // #253: the tenant parent switch must be ON for the public surface

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

// #227 comment 1078 ①②: the public reader reuses the member frosted TITLE BAND (read-only PageTitle) and
// shows a TABLE OF CONTENTS built from the rendered body's headings (jump + scroll-sync). Real Chromium.
test("#227 review: the public page has the member title band and a working TOC", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-toc");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  // multiple headings + tall bodies so the TOC has entries and jumping actually scrolls.
  const filler = Array.from({ length: 25 }, (_, i) => `para ${i}`).join("\n\n");
  await authed.keyboard.insertText(`# Top Title\n\n## Alpha Section\n\n\`\`\`js\nconst answer = 42;\n\`\`\`\n\n${filler}\n\n## Bravo Section\n\n${filler}\n\n## Charlie Section\n\n${filler}\n`);
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  // anonymous, WIDE viewport (≥1200px so the TOC rail shows).
  const anon = await (await browser.newContext({ viewport: { width: 1360, height: 800 } })).newPage();
  await anon.goto(`/pub/${id}`);
  // ① the frosted band renders the PAGE title through the read-only PageTitle (page-title inside public-title).
  await expect(anon.getByTestId("public-title")).toBeVisible();
  await expect(anon.getByTestId("public-title").getByTestId("page-title")).toHaveText("pub-toc"); // the page title
  // ② the TOC rail shows an item per heading.
  const toc = anon.getByTestId("toc");
  await expect(toc).toBeVisible();
  const items = toc.getByTestId("toc-item");
  await expect(items).toHaveCount(4); // Top Title + Alpha/Bravo/Charlie

  // #227 ①: the TOC rail must stay VIEWPORT-FIXED — scrolling the content must NOT carry the rail
  // off-screen (the bug: the rail sat in the scroll container, so scrollTop 800 pushed its items to top<0).
  const firstItemTopBefore = await items.first().evaluate((el) => el.getBoundingClientRect().top);
  await anon.locator(".wks-public > div").first().evaluate((el) => { el.scrollTop = 800; });
  await sleep(200);
  const firstItemTopAfter = await items.first().evaluate((el) => el.getBoundingClientRect().top);
  expect(firstItemTopAfter).toBeGreaterThan(0); // still on screen after scrolling
  expect(Math.abs(firstItemTopAfter - firstItemTopBefore)).toBeLessThan(24); // barely moved (fixed, not scrolled away)

  // #227 ②: clicking a section jumps to it and the heading lands BELOW the frosted band, not behind it
  // (the bug: scrollIntoView with no scroll-margin put the heading at top≈40px, inside the blurred band).
  await items.filter({ hasText: "Charlie" }).click();
  await sleep(600); // smooth-scroll settle
  const headingTop = await anon.getByTestId("public-body").locator("h2", { hasText: "Charlie Section" }).evaluate((el) => el.getBoundingClientRect().top);
  const bandBottom = await anon.getByTestId("public-band").evaluate((el) => el.getBoundingClientRect().bottom);
  expect(headingTop).toBeLessThan(300); // it DID scroll near the top…
  expect(headingTop).toBeGreaterThanOrEqual(bandBottom - 6); // …but clears the band (not hidden behind the blur)

  // #227 ②: a public code block gets a copy button (parity with the editor fence header).
  await expect(anon.getByTestId("public-body").locator("pre .cm-lp-code-copy")).toHaveCount(1);

  // #227 ①: a TOC on/off toggle hides/shows the rail (device-local pref, parity with the member view).
  await expect(anon.getByTestId("toc")).toBeVisible(); // on by default (useTocPref default ON)
  await anon.getByTestId("toc-toggle").click();
  await expect(anon.getByTestId("toc")).toHaveCount(0); // hidden
  await anon.getByTestId("toc-toggle").click();
  await expect(anon.getByTestId("toc")).toBeVisible(); // shown again
});

// #227 on a NARROW screen the public reader must reuse the MEMBER TOC UI — the toggle stays visible
// and a scroll overlay appears (the old public-only impl was wide-only, so the TOC + toggle vanished when the
// window was small). Real Chromium at 600px.
test("#227 the public TOC works on a narrow screen (toggle + scroll overlay, member parity)", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-toc-narrow");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  const filler = Array.from({ length: 25 }, (_, i) => `para ${i}`).join("\n\n");
  await authed.keyboard.insertText(`# Top Title\n\n## Alpha Section\n\n${filler}\n\n## Bravo Section\n\n${filler}\n\n## Charlie Section\n\n${filler}\n`);
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  // anonymous, NARROW viewport (< the wide breakpoint, so the rail does NOT apply — the overlay path does).
  const anon = await (await browser.newContext({ viewport: { width: 600, height: 800 } })).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-title")).toBeVisible();

  // ① the toggle is present on a narrow screen (was isWide-gated → absent, the reported bug).
  const toggle = anon.getByTestId("toc-toggle");
  await expect(toggle).toBeVisible();

  // ② the overlay TOC exists (tocOn default) and fades IN while scrolling (member overlay behaviour).
  const overlay = anon.locator('[data-testid=toc][data-variant=overlay]');
  await expect(overlay).toHaveCount(1);
  await anon.locator(".wks-public > div").first().evaluate((el) => { el.scrollTop = 500; });
  await sleep(150);
  await expect(overlay).toHaveCSS("opacity", "1"); // visible while scrolling
  await expect(overlay.getByTestId("toc-item")).toHaveCount(4);

  // ③ the toggle OFF removes the overlay entirely (device-local pref, same as the rail).
  await toggle.click();
  await expect(anon.getByTestId("toc")).toHaveCount(0);
});

// #267 : the callout BOX (tint + left bar) and default-CENTER diagrams must also render on the
// PUBLIC reader — it uses the same renderMarkdownToDom outside .cm-editor. Two-surface regression for #267.
test("#267 波及: the public reader shows the callout box + centers a mermaid diagram", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-callout-mermaid");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("# Doc\n\n:::info\nHeads up **note**\n:::\n\n```mermaid\nflowchart TD\n  A --> B\n```\n");
  await sleep(500);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext({ viewport: { width: 1360, height: 800 } })).newPage();
  await anon.goto(`/pub/${id}`);
  const body = anon.getByTestId("public-body");
  // the callout renders as a PANEL with a real background tint + a left colour bar (not flat text).
  const panel = body.locator("[data-testid=callout-panel]");
  await expect(panel).toHaveCount(1);
  const box = await panel.evaluate((el) => { const cs = getComputedStyle(el); return { bg: cs.backgroundColor, bar: parseFloat(cs.borderLeftWidth) }; });
  expect(box.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(box.bar).toBeGreaterThan(0);
  // the mermaid diagram is centered by default (#255), matching the editor.
  const mermaid = body.locator(".cm-lp-mermaid").first();
  await expect(mermaid).toHaveClass(/cm-lp-align-center/);
  expect(await mermaid.evaluate((el) => getComputedStyle(el).alignItems)).toBe("center");
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
  await setPublicSurface(authed, true); // surface ON — proving the 404 below is the page's non-public state, not the switch
  // published but NOT public → anonymous 404 → not-found screen
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-not-found")).toBeVisible();
  expect(await anon.getByTestId("public-title").count()).toBe(0);
});

// #253 / ADR-113 (guardrail 1): the tenant PARENT SWITCH. A page that IS public renders while the switch is
// ON, then 404s the instant it is turned OFF — the whole public surface is hidden tenant-wide, non-destructively
// (the grant is untouched, so turning it back ON restores the page). The server is the fortress: this is the
// read-time gate, not the hidden UI.
test("#253: the tenant parent switch OFF hides an otherwise-public page (404), ON restores it", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-switch");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("# Switchable\n\nvisible only while the surface is on\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);

  // Switch ON → the public page renders.
  await setPublicSurface(authed, true);
  const anon1 = await (await browser.newContext()).newPage();
  await anon1.goto(`/pub/${id}`);
  await expect(anon1.getByTestId("public-title")).toBeVisible();

  // Switch OFF → the SAME public page 404s (parent-switch gate), no grant change.
  await setPublicSurface(authed, false);
  const anon2 = await (await browser.newContext()).newPage();
  await anon2.goto(`/pub/${id}`);
  await expect(anon2.getByTestId("public-not-found")).toBeVisible();

  // Switch back ON → restored (non-destructive).
  await setPublicSurface(authed, true);
  const anon3 = await (await browser.newContext()).newPage();
  await anon3.goto(`/pub/${id}`);
  await expect(anon3.getByTestId("public-title")).toBeVisible();
});
