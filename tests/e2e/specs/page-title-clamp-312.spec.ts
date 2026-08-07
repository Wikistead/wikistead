import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { enterEdit, FGA, openScratch, setPublicSurface, sleep } from "../helpers";

// #312: the title-band STATIC title must clamp to at most 2 lines on EVERY surface — the view
// surface, the page-EDIT mode (the bug: its `block` branch let a 4-line title grow the band), and
// the public reader. The full title stays reachable via the rename textarea (wraps in full).
// Geometry asserted in a real browser (happy-dom has no layout engine).

const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
const STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
const MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();

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

// Long enough to wrap to 4+ lines in the ~740px reading column at 30px bold.
const LONG = "An Extremely Long Page Title That Keeps Going And Going Across The Reading Column To Verify The Two Line Clamp Behaviour Of The Frosted Title Band In Every Surface And Mode Without Exception";

// The static title's height budget: 2 × line-height + a small ε.
async function titleMetrics(page: Page) {
  const el = page.getByTestId("page-title").first();
  return el.evaluate((n) => {
    const cs = getComputedStyle(n);
    return { h: n.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight) };
  });
}

test("#312 title clamps to 2 lines in view AND edit mode; the rename textarea wraps in full", async ({ page }) => {
  await openScratch(page, LONG);

  // (a) view surface: ≤ 2 lines
  let m = await titleMetrics(page);
  expect(m.h, `view title height ${m.h} vs 2 lines of ${m.lh}`).toBeLessThanOrEqual(m.lh * 2 + 4);
  expect(m.h, "actually wrapped (not a single line)").toBeGreaterThan(m.lh * 1.5);

  // (b) page-EDIT mode, rename NOT open: still ≤ 2 lines (the #312 bug showed 4)
  await enterEdit(page);
  m = await titleMetrics(page);
  expect(m.h, `edit-mode title height ${m.h} vs 2 lines of ${m.lh}`).toBeLessThanOrEqual(m.lh * 2 + 4);

  // (c) the rename textarea shows the FULL wrapped title (auto-grown beyond 2 lines, no inner scroll)
  await page.getByTestId("page-title").click();
  const ta = page.getByTestId("page-title-input");
  await expect(ta).toBeVisible();
  const taM = await ta.evaluate((n) => {
    const cs = getComputedStyle(n);
    return { h: n.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight), scrollFits: n.scrollHeight <= n.clientHeight + 2 };
  });
  expect(taM.h, "textarea grew past the 2-line clamp (full title visible)").toBeGreaterThan(taM.lh * 2.5);
  expect(taM.scrollFits, "textarea auto-grew (no inner scroll)").toBe(true);
  await page.keyboard.press("Escape");
});

test("#312 public reader title band clamps to 2 lines too", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, LONG);
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText("public body");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByTestId("public-title")).toBeVisible();
  const m = await anon.getByTestId("page-title").first().evaluate((n) => {
    const cs = getComputedStyle(n);
    return { h: n.getBoundingClientRect().height, lh: parseFloat(cs.lineHeight) };
  });
  expect(m.h, `public title height ${m.h} vs 2 lines of ${m.lh}`).toBeLessThanOrEqual(m.lh * 2 + 4);
});
