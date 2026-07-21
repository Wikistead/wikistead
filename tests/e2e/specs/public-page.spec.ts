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
  // #319: rendered by the member CM6 engine — a heading is a `.cm-lp-h1` line (not an <h1> tag), same as the
  // real page; the markdown `#` marker is hidden on the read surface.
  await expect(body.locator(".cm-lp-h1")).toContainText("Public Heading");
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

  // #227①: the TOC rail must stay VIEWPORT-FIXED — scrolling the content must NOT carry the rail
  // off-screen (the bug: the rail sat in the scroll container, so scrollTop 800 pushed its items to top<0).
  const firstItemTopBefore = await items.first().evaluate((el) => el.getBoundingClientRect().top);
  await anon.locator("[data-testid=public-body] .cm-scroller").evaluate((el) => { el.scrollTop = 800; });
  await sleep(200);
  const firstItemTopAfter = await items.first().evaluate((el) => el.getBoundingClientRect().top);
  expect(firstItemTopAfter).toBeGreaterThan(0); // still on screen after scrolling
  expect(Math.abs(firstItemTopAfter - firstItemTopBefore)).toBeLessThan(24); // barely moved (fixed, not scrolled away)

  // #227② / #319: a public code block gets a copy button — now the CM engine's own `.cm-lp-code-copy`
  // (no <pre> wrapper on the CM surface), parity with the member Reading view. Checked BEFORE the jump below,
  // while the top-of-doc code fence is still in the CM viewport (the CM read surface VIRTUALIZES, so after a
  // jump to the bottom the top fence is unmounted — that is correct virtualization, not a missing button).
  await anon.locator("[data-testid=public-body] .cm-scroller").evaluate((el) => { el.scrollTop = 0; });
  await expect(anon.getByTestId("public-body").locator(".cm-lp-code-copy")).toHaveCount(1);

  // #227②: clicking a section jumps to it and the heading lands BELOW the frosted band, not behind it
  // (the bug: scrollIntoView with no scroll-margin put the heading at top≈40px, inside the blurred band).
  await items.filter({ hasText: "Charlie" }).click();
  await sleep(600); // smooth-scroll settle
  const headingTop = await anon.getByTestId("public-body").locator(".cm-lp-h2", { hasText: "Charlie Section" }).evaluate((el) => el.getBoundingClientRect().top);
  const bandBottom = await anon.getByTestId("public-band").evaluate((el) => el.getBoundingClientRect().bottom);
  expect(headingTop).toBeLessThan(300); // it DID scroll near the top…
  expect(headingTop).toBeGreaterThanOrEqual(bandBottom - 6); // …but clears the band (not hidden behind the blur)

  // #227①: a TOC on/off toggle hides/shows the rail (device-local pref, parity with the member view).
  await expect(anon.getByTestId("toc")).toBeVisible(); // on by default (useTocPref default ON)
  await anon.getByTestId("toc-toggle").click();
  await expect(anon.getByTestId("toc")).toHaveCount(0); // hidden
  await anon.getByTestId("toc-toggle").click();
  await expect(anon.getByTestId("toc")).toBeVisible(); // shown again
});

// #227on a NARROW screen the public reader must reuse the MEMBER TOC UI — the toggle stays visible
// and a scroll overlay appears (the old public-only impl was wide-only, so the TOC + toggle vanished when the
// window was small). Real Chromium at 600px.
test("#227the public TOC works on a narrow screen (toggle + scroll overlay, member parity)", async ({ browser }) => {
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
  await anon.locator("[data-testid=public-body] .cm-scroller").evaluate((el) => { el.scrollTop = 500; });
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
  // #319: the mermaid diagram RENDERS on the public reader (was a raw ```mermaid source dump before) and is
  // centered by default (#255) — the align class sits on the widget wrapper (decorations.ts), same as the editor.
  await expect(anon.getByTestId("macro-mermaid")).toBeVisible();
  await expect(body.locator(".cm-lp-align-center")).toHaveCount(1);
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

// #227/rework: the standalone public page /pub/:id). ① the TOC toggle is the MEMBER
// PageStatus ToggleButton riding the band row (the public-only floating button is gone); ② page-level
// publish shows ONLY the page — no bottom child tree even when public children exist; ③ the band is
// sticky on the standalone route too (it had no bounded-height ancestor, so sticky never engaged).
test("#227/standalone /pub/:id — member toggle in the band, NO child tree, sticky band", async ({ browser }) => {
  const API = "http://dev.localhost:4010";
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-standalone");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  const filler = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n\n");
  await authed.keyboard.insertText(`# Solo Title\n\n## One Section\n\n${filler}\n`);
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  // a PUBLIC, published child page under it — its existence must NOT render a bottom tree (②).
  const childId = await authed.evaluate(async ({ api, id }) => {
    const page = await (await fetch(`${api}/pages/${id}`, { headers: { Authorization: "Bearer dev-token" } })).json();
    const r = await fetch(`${api}/spaces/${page.spaceId}/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "Solo Child", parentId: id }),
    });
    return ((await r.json()) as { id: string }).id;
  }, { api: API, id });
  await authed.evaluate(async ({ api, id }) => {
    await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, id: childId });
  await makePublic(childId);
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext({ viewport: { width: 1360, height: 800 } })).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-title")).toBeVisible();
  // ① member parity: the toggle is INSIDE the band's PageStatus — and no second (floating) toggle exists.
  await expect(anon.locator("[data-testid=page-status] [data-testid=toc-toggle]")).toHaveCount(1);
  await expect(anon.getByTestId("toc-toggle")).toHaveCount(1);
  // ② no bottom child tree on the standalone page (page-level publish shows ONLY the page).
  await expect(anon.getByTestId("public-children")).toHaveCount(0);
  await expect(anon.locator(`[data-testid=public-child-${childId}]`)).toHaveCount(0);
  // ③ sticky: scrolling the content keeps the band pinned at the viewport top (①).
  const yBefore = (await anon.getByTestId("public-band").boundingBox())!.y;
  await anon.locator("[data-testid=public-body] .cm-scroller").evaluate((el) => { el.scrollTop = 800; });
  await sleep(200);
  const yAfter = (await anon.getByTestId("public-band").boundingBox())!.y;
  expect(Math.abs(yAfter - yBefore), `band y ${yBefore} → ${yAfter} must stay pinned`).toBeLessThanOrEqual(2);
});

// #319(review bounce): loading the public reader on the member CM6 engine leaked two
// editor-only behaviours onto the read-only anonymous surface. A: the 740px reading column didn't apply
// (the body host lacked data-pane="preview") → full width. B: block macros showed the editor's hover
// edit-frame (and ✎) even though nothing is editable. Both are display-only (authz/XSS untouched).
test("#319public reader has the reading column AND no read-only macro edit affordances", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-readonly-chrome");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("# Wide Heading\n\n```mermaid\nflowchart TD\n  A --> B\n```\n\ntail\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-title")).toBeVisible();
  const body = anon.getByTestId("public-body");

  // A: the reading column (740px, centred) applies — the content is NOT full viewport width.
  const contentW = await body.locator(".cm-content").evaluate((el) => parseFloat(getComputedStyle(el).maxWidth));
  expect(contentW, `public .cm-content max-width ${contentW}px is the 740px reading column`).toBeLessThanOrEqual(760);

  // B: the block macro renders, but hovering it shows NO edit frame (read-only) and there is NO ✎ edit button.
  const wrap = body.locator(".cm-lp-macro-wrap").first();
  await expect(wrap).toBeVisible({ timeout: 10000 });
  await wrap.hover();
  await sleep(150);
  const outline = await wrap.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline, "a read-only macro shows no hover edit-frame outline").toBe("none");
  expect(await body.locator("[data-testid=macro-edit]").count(), "no ✎ edit button on a read-only surface").toBe(0);
});

// #319the public reader is now the SAME mountPublishedView engine as the editor, but a leftover
// renderMarkdownToDom prose rule (`.wks-public [data-testid=public-body] table { width:100% }`) still matched
// the CM `.cm-lp-table` and stretched a public table to full width while the editor's stayed content-width.
// Removing the stale prose rules makes both surfaces inherit the baseTheme identically. Real Chromium geometry.
test("#319a table renders at the SAME (content) width in the editor and the public reader", async ({ browser }) => {
  const authed = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const id = await openScratch(authed, "pub-table-width");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("| A | B |\n| --- | --- |\n| 1 | 2 |\n\ntail\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  // editor view (mountPublishedView) — the rendered table's width.
  await authed.goto(`/p/${id}`);
  await authed.waitForSelector("[data-pane=preview] .cm-lp-table", { timeout: 10000 });
  const editW = (await authed.locator("[data-pane=preview] .cm-lp-table").first().boundingBox())!.width;

  // public reader — the SAME table.
  const anon = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  await anon.goto(`/pub/${id}`);
  await anon.waitForSelector("[data-testid=public-body] .cm-lp-table", { timeout: 10000 });
  const pubW = (await anon.locator("[data-testid=public-body] .cm-lp-table").first().boundingBox())!.width;

  expect(Math.abs(editW - pubW), `table width editor ${editW} vs public ${pubW} must match (public was full-width before)`).toBeLessThanOrEqual(2);
  // …and it is content-width, not stretched to the 740px reading column.
  expect(pubW, `public table ${pubW}px should be content-width, not the full reading column`).toBeLessThan(600);
});

// #335footnote (and real) links must look IDENTICAL on the public reader /pub) and the member Reading
// view /p) — both are the same CM6 read engine now (#319). A stale `.wks-public [data-testid=public-body] a`
// rule in public.css (accent + underline) used to override the shared `.cm-lp-footnote-ref a` (var(--link), no
// underline) ONLY on the public surface; removing the stale prose CSS (with #319) restores parity. Pin
// the COMPUTED colour + text-decoration-line on both surfaces. Real Chromium.
test("#335footnote + real links match between the public reader and member Reading", async ({ browser }) => {
  const authed = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  const id = await openScratch(authed, "fn-link-parity");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("A body with a note[^1] and a [real link](https://example.com).\n\n[^1]: the note body\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  // measure the footnote ref link + a real link's computed color + underline on a given page/root.
  const linkStyles = (page: import("@playwright/test").Page, root: string) => page.evaluate((root) => {
    const scope = document.querySelector(root) as HTMLElement;
    const fn = scope?.querySelector(".cm-lp-footnote-ref a") as HTMLElement | null;
    const real = scope?.querySelector('a[href="https://example.com"], a[data-href="https://example.com"]') as HTMLElement | null;
    const read = (el: HTMLElement | null) => (el ? { color: getComputedStyle(el).color, deco: getComputedStyle(el).textDecorationLine } : null);
    return { fn: read(fn), real: read(real) };
  }, root);

  // member Reading view /p → enter edit → the Reading display mode is read-only rendering).
  await authed.goto(`/p/${id}`);
  await authed.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(authed);
  await authed.getByTestId("displaymode-reading").click();
  await authed.waitForSelector("[data-pane=preview] .cm-lp-footnote-ref a", { timeout: 10000 });
  const member = await linkStyles(authed, "[data-pane=preview] .cm-content");

  // public reader /pub).
  const anon = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
  await anon.goto(`/pub/${id}`);
  await anon.waitForSelector("[data-testid=public-body] .cm-lp-footnote-ref a", { timeout: 10000 });
  const pub = await linkStyles(anon, "[data-testid=public-body]");

  expect(member.fn, "footnote ref link exists on both").not.toBeNull();
  expect(pub.fn, "footnote ref link exists on both").not.toBeNull();
  expect(pub.fn!.color, `footnote link colour public ${pub.fn!.color} vs member ${member.fn!.color}`).toBe(member.fn!.color);
  expect(pub.fn!.deco, `footnote link underline public ${pub.fn!.deco} vs member ${member.fn!.deco}`).toBe(member.fn!.deco);
  if (member.real && pub.real) {
    expect(pub.real.color, `real link colour public ${pub.real.color} vs member ${member.real.color}`).toBe(member.real.color);
    expect(pub.real.deco, `real link underline public ${pub.real.deco} vs member ${member.real.deco}`).toBe(member.real.deco);
  }
});

// #429: the standalone public reader has a floating THEME TOGGLE — an anonymous visitor picks
// light/dark themselves (localStorage + <html data-theme>), and the choice survives a reload.
test("#429: the anonymous /pub reader can switch light/dark and the choice persists", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-theme");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("theme toggle body\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-body")).toContainText("theme toggle body");
  // #430: the toggle moved from the floating corner into the minimal public HEADER.
  const corner = anon.getByTestId("public-header");
  await expect(corner).toBeVisible();
  // Pick DARK from the menu → <html data-theme="dark"> + persisted. Items are picked by
  // POSITION (ThemeToggle's fixed ORDER: light, dark, system) — labels are localized.
  await corner.getByTestId("theme-toggle").click();
  await anon.getByTestId("theme-menu").locator('[role="menuitem"]').nth(1).click();
  await expect(anon.locator("html")).toHaveAttribute("data-theme", "dark");
  // Survives a reload (localStorage, no session involved).
  await anon.reload();
  await expect(anon.getByTestId("public-body")).toContainText("theme toggle body");
  await expect(anon.locator("html")).toHaveAttribute("data-theme", "dark");
  // And back to LIGHT in-page.
  await corner.getByTestId("theme-toggle").click();
  await anon.getByTestId("theme-menu").locator('[role="menuitem"]').nth(0).click();
  await expect(anon.locator("html")).toHaveAttribute("data-theme", "light");
});

// #430: the public reader's MINIMAL header — brand + theme toggle live in a real header now (the #429
// floating corner grew into it), and the FREE plan shows a subtle "Powered by Wikistead" (the freemium
// ruling; a paid tenant white-labels via the one /branding entitlement seam — whitelabel:true hides it).
// The anonymous surface still carries NO member chrome (search / bell / user menu / sidebar toggle).
test("#430: the standalone public page has the minimal header — brand + powered-by + theme, NO member chrome", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, "pub-header-430");
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("# Header Test\n\nbody\n");
  await sleep(300);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`/pub/${id}`);
  const header = anon.getByTestId("public-header");
  await expect(header).toBeVisible({ timeout: 10000 });
  // the powered-by marker follows the ONE entitlement seam: free plan → visible; a branding-entitled
  // (white-label) tenant → absent. Read the live seam so the pin is plan-agnostic; the per-plan matrix
  // is pinned deterministically server-side (branding unit tests).
  const wl = (await (await anon.request.get("/api/branding")).json()).whitelabel as boolean;
  if (wl) await expect(header.getByTestId("powered-by")).toHaveCount(0);
  else await expect(header.getByTestId("powered-by")).toBeVisible();
  // the #429 theme AND language toggles ride the header (ruling) — and language actually switches
  await expect(header.getByTestId("theme-toggle")).toBeVisible();
  await header.getByTestId("language-toggle").click();
  await anon.getByTestId("language-ja").click();
  await expect(anon.locator("html")).toHaveAttribute("lang", "ja"); // anon context is throwaway — no switch-back needed
  // anti-chrome: none of the member controls exist on the anonymous surface
  for (const tid of ["sidebar-toggle", "search-open", "notification-bell", "user-menu", "edit-toggle", "new-page"]) {
    await expect(anon.getByTestId(tid), tid).toHaveCount(0);
  }
  // the page body still renders below the header (bounded-height context intact)
  await expect(anon.getByTestId("public-title")).toBeVisible();

  // #430the header's LEFT side is never empty. The standalone reader rendered the header with
  // no space context at all, and a white-label tenant (the self-host default) also suppresses the brand
  // mark and name — so the whole left side was blank. The space identity (icon + name) belongs to the
  // tenant, not to Wikistead's branding, so it shows on every plan.
  const spaceCtx = header.getByTestId("public-space-context");
  await expect(spaceCtx, "the space context is present regardless of white-labelling").toBeVisible({ timeout: 8000 });
  await expect(spaceCtx.getByTestId("public-space-icon"), "…with an icon (uploaded image or initials chip)").toBeVisible();
  const spaceLabel = (await spaceCtx.innerText()).trim();
  expect(spaceLabel.length, `the space name renders (got "${spaceLabel}")`).toBeGreaterThan(0);
  //"the header is not blank" used to read header.innerText, which includes the theme and
  // language toggles on the right — it passed with the left side completely empty, i.e. with the exact
  // defect it was written for. Name the left slot instead.
  const brandOrSpace = await header.getByTestId("public-brand").count() + await header.getByTestId("public-brand-logo").count()
    + await header.getByTestId("public-space-context").count();
  expect(brandOrSpace, "the header's LEFT slot carries a brand or the space identity").toBeGreaterThan(0);
});

//ruling: white-labelling REPLACES the Wikistead brand with the tenant's own rather than erasing
// it, so the mark and the name follow "has this tenant set a brand?", not "is it entitled to one?".
// The state that made this matter is the one every paying customer starts in — entitled, nothing set
// which rendered an empty header, so paying looked worse than not paying. Driven through the real
// branding endpoint (no response mocking): the decision is client-side, but the input must be real.
test("#430the public header falls back to the Wikistead brand until the tenant sets its own", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  const pageId = await openScratch(member, "pub-brand-430");
  await enterEdit(member);
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.insertText("# Brand Test\n\nbody\n");
  await sleep(300);
  await member.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(pageId);
  await setPublicSurface(member, true);
  const before = await (await member.request.get("/api/branding")).json() as { displayName: string | null; accentKey: string | null };
  // PATCH writes BOTH fields and nulls whatever it is not given, so carry the accent through or the
  // test would quietly reset the tenant's colour on its way past.
  const setName = async (displayName: string | null) => member.evaluate(async (b) => {
    const r = await fetch("/api/tenant/branding", { method: "PATCH", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify(b) });
    return r.status;
  }, { displayName, accentKey: before.accentKey });

  try {
    // (1) nothing of its own set → the default Wikistead brand, on whatever plan this stack runs
    expect(await setName(null), "clearing the display name").toBe(204);
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(`/pub/${pageId}`);
    const header = anon.getByTestId("public-header");
    await expect(header).toBeVisible({ timeout: 10000 });
    await expect(header.getByTestId("brand-mark"), "the Wikistead mark stands in for an unset brand").toBeVisible();
    await expect(header.getByTestId("public-brand")).toHaveText("Wikistead");

    // (2) a brand of its own → that name, and the Wikistead mark steps aside
    expect(await setName("Acme Docs"), "setting a display name").toBe(204);
    await anon.reload();
    await expect(header.getByTestId("public-brand"), "the tenant's own name replaces Wikistead").toHaveText("Acme Docs");
    await expect(header.getByTestId("brand-mark"), "…and so does its mark").toHaveCount(0);

    // (3) the attribution is a different thing from the identity: it stays on the entitlement seam
    const wl = (await (await anon.request.get("/api/branding")).json()).whitelabel as boolean;
    await expect(header.getByTestId("powered-by")).toHaveCount(wl ? 0 : 1);
  } finally {
    await setName(before.displayName);
  }
});
