import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterEdit, openScratch, setPublicSurface, sleep } from "../helpers";

// #465: a mermaid SVG carries `width="100%"` + a viewBox — no INTRINSIC width. Inside the #255 align
// wrap (display:flex; align-items:center → shrink-to-fit) the width resolution is circular and the
// browser falls back to the CSS default replaced size, 300px: a 650px-wide sequence diagram rendered
// at 300px (46%). The fix gives the SVG a px width from its viewBox plus an inline max-width:100%.
// Pins (real Chromium, both surfaces): wide viewport → intrinsic width, narrow → clamped without
// overflow, alignment preserved.
const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
const STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
const MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();
const FGA = "http://localhost:8090";

// A diagram whose natural width is comfortably past the 300px default.
const DIAGRAM = [
  "```mermaid",
  "sequenceDiagram",
  "    participant C as Claude",
  "    participant M as MCP",
  "    participant W as Wikistead",
  "    C->>M: create_page",
  "    M->>W: draft creation",
  "    W-->>M: pageId",
  "    C->>M: publish_page",
  "    M->>W: revision recorded",
  "```",
].join("\n");

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

// The SVG's own coordinate width (viewBox) vs what it actually paints at.
async function svgGeom(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector("[data-pane=preview] [data-testid=macro-mermaid] svg") as SVGSVGElement | null;
    if (!svg) return null;
    const vb = svg.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
    const host = svg.closest(".cm-lp-macro-wrap") as HTMLElement | null;
    return {
      intrinsic: vb && vb.length === 4 ? vb[2]! : 0,
      painted: svg.getBoundingClientRect().width,
      hostWidth: host?.getBoundingClientRect().width ?? 0,
      hostOverflow: host ? host.scrollWidth - host.clientWidth : 0,
      hostLeft: host?.getBoundingClientRect().left ?? 0,
      svgLeft: svg.getBoundingClientRect().left,
    };
  });
}

test("#465: a wide mermaid diagram paints at its intrinsic width, clamps in a narrow column, and stays centered", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const id = await openScratch(page, `mermaid465-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`${DIAGRAM}\n\nbelow\n`);
  await sleep(1500); // mermaid renders async
  await page.getByText("below", { exact: true }).click();
  await sleep(800);

  const wide = (await svgGeom(page))!;
  expect(wide.intrinsic, "the diagram is naturally wider than the 300px default").toBeGreaterThan(400);
  // 1. WIDE: painted at (about) its intrinsic width — NOT collapsed to the 300px replaced default.
  expect(wide.painted, `painted ${wide.painted} vs intrinsic ${wide.intrinsic}`).toBeGreaterThan(wide.intrinsic * 0.9);
  // 2. centered inside the align wrap (the #255 behaviour must survive)
  const leftGap = wide.svgLeft - wide.hostLeft;
  const rightGap = wide.hostWidth - wide.painted - leftGap;
  expect(Math.abs(leftGap - rightGap), "centered in the align wrap").toBeLessThan(6);

  // 3. NARROW: publish, then re-open at a narrow viewport — clamped to the column, no overflow.
  await page.getByTestId("publish-page").click();
  await sleep(900);
  await makePublic(id);
  await setPublicSurface(page, true);

  const narrow = await (await browser.newContext({ viewport: { width: 500, height: 900 } })).newPage();
  await narrow.goto(`/pub/${id}`);
  await narrow.waitForSelector("[data-testid=macro-mermaid] svg", { timeout: 15_000 });
  await sleep(600);
  const pub = await narrow.evaluate(() => {
    const svg = document.querySelector("[data-testid=macro-mermaid] svg") as SVGSVGElement | null;
    const host = svg?.closest(".cm-lp-macro-wrap") as HTMLElement | null;
    return svg && host
      ? { painted: svg.getBoundingClientRect().width, hostWidth: host.getBoundingClientRect().width, overflow: host.scrollWidth - host.clientWidth }
      : null;
  });
  expect(pub, "the public reader renders the diagram too").not.toBeNull();
  expect(pub!.painted, "clamped to the column").toBeLessThanOrEqual(pub!.hostWidth + 1);
  expect(pub!.overflow, "no horizontal overflow in a narrow column").toBeLessThanOrEqual(1);
});

test("#465: the PUBLIC reader paints a wide diagram at its intrinsic width too", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const id = await openScratch(page, `mermaid465-pub-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(`${DIAGRAM}\n\nbelow\n`);
  await sleep(1200);
  await page.getByTestId("publish-page").click();
  await sleep(900);
  await makePublic(id);
  await setPublicSurface(page, true);

  const anon = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await anon.goto(`/pub/${id}`);
  await anon.waitForSelector("[data-testid=macro-mermaid] svg", { timeout: 15_000 });
  await sleep(800);
  const geom = await anon.evaluate(() => {
    const svg = document.querySelector("[data-testid=macro-mermaid] svg") as SVGSVGElement | null;
    if (!svg) return null;
    const vb = svg.getAttribute("viewBox")?.split(/[\s,]+/).map(Number);
    return { intrinsic: vb && vb.length === 4 ? vb[2]! : 0, painted: svg.getBoundingClientRect().width };
  });
  expect(geom).not.toBeNull();
  expect(geom!.intrinsic).toBeGreaterThan(400);
  expect(geom!.painted, `public painted ${geom!.painted} vs intrinsic ${geom!.intrinsic}`).toBeGreaterThan(geom!.intrinsic * 0.9);
});
