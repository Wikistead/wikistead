import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #527: a drawing made in a nested macro's MODAL was silently discarded.
//
// The macro modal is a page-level overlay, so focus moving into it looked exactly like leaving the slot
// island the macro lives in. The island committed and tore itself down at that moment — taking with it
// the inner view the modal had captured — so the modal's Save dispatched into a detached editor and the
// document never changed. No error, no warning: the drawing was simply gone.
//
// The earlier investigation missed it because it only ever saved an UNCHANGED scene, where "wrote it
// back" and "wrote nothing" are both byte-identical. This test therefore CHANGES the scene, and does it
// with the keyboard: Excalidraw ignores synthetic drags but moves a selection on arrow keys, which is a
// real scene mutation with a coordinate we can read back out of the document.
const rect = (x: number) => JSON.stringify({
  type: "excalidraw", version: 2, source: "test",
  elements: [{
    id: "n527-rect", type: "rectangle", x, y: 100, width: 120, height: 80, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2,
    strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
  }],
  appState: { gridSize: null, viewBackgroundColor: "#ffffff" }, files: {},
});

const NESTED = "::::columns\n:::column\nintro\n\n```excalidraw\n" + rect(50) + "\n```\n:::\n:::column\nBBB\n:::\n::::\n";

//(review reject): the fixture for the follow-up regression needs a SECOND container after
// the columns, because the bug is about what a committed island above does to the widgets below it.
const TWO_CONTAINERS = NESTED + "\nplain paragraph\n\n::::tabs\n:::tab[One]\ntab body one\n:::\n:::tab[Two]\ntab body two\n:::\n::::\n";

// Read the element's x out of the PUBLISHED body — the CM surface is virtualized, so its DOM is not the
// document.
async function publishedX(page: import("@playwright/test").Page, id: string): Promise<number | null> {
  const md = await page.evaluate(async ({ api, id }) => {
    const H = { Authorization: "Bearer dev-token" };
    await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: H });
    const r = await fetch(`${api}/pages/${id}/published`, { headers: H });
    return r.ok ? (((await r.json()) as { publishedMd?: string })?.publishedMd ?? "") : "";
  }, { api: API, id });
  const at = md.indexOf("n527-rect");
  if (at < 0) return null;
  const m = /"x"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(md.slice(Math.max(0, at - 400), at + 400));
  return m ? Number(m[1]) : null;
}

test("#527: a scene edited in a NESTED macro's modal survives the save", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, `n527-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(NESTED);
  await sleep(2000);
  expect(await publishedX(page, id), "the fixture landed").toBe(50);

  // One click enters the slot island (the #278ruling); inside it the nested macro behaves
  // top-level, so its own ✎ opens the modal.
  const macro = page.locator("[data-pane=preview] [data-testid=macro-excalidraw]").first();
  await macro.click();
  await sleep(900);
  await expect(page.locator(".cm-lp-slot-edit-island"), "the click entered the island").toHaveCount(1);
  await page.getByTestId("macro-edit").first().click();
  await expect(page.locator(".wks-macro-modal .excalidraw")).toBeVisible({ timeout: 20000 });

  // THE REGRESSION: the island must still be alive while its own modal is open. Without this the modal
  // holds a destroyed view and Save writes nowhere.
  await expect(page.locator(".cm-lp-slot-edit-island"), "the island survives its own modal").toHaveCount(1);

  // Move the selection with the keyboard — a real scene change, verified by Undo becoming enabled
  // (otherwise this test would "save" an unchanged scene and prove nothing).
  const canvas = page.locator(".excalidraw canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(400);
  await page.keyboard.press("Control+a");
  await sleep(300);
  for (let i = 0; i < 10; i++) { await page.keyboard.press("ArrowRight"); await sleep(40); }
  await sleep(600);
  const undoEnabled = await page.evaluate(() => {
    const b = document.querySelector('.excalidraw [data-testid="button-undo"], .excalidraw button[aria-label*="Undo"]') as HTMLButtonElement | null;
    return b ? !b.disabled : null;
  });
  expect(undoEnabled, "the nudge really changed the scene").toBe(true);

  await page.getByTestId("macro-modal-save").click();
  await sleep(800);
  // The island commits on leave (its contract), so step out before reading the document.
  await page.keyboard.press("Escape").catch(() => {});
  await page.mouse.click(8, 8);
  await sleep(1500);

  expect(await publishedX(page, id), "the drawing reached the canonical document").toBe(60);
});

//(review reject): after a modal edit, clicking another container's slot could never open
// its island again. The container widgets are eq()-reused across an unrelated doc change (their
// stable-key contract), but the slot-open listeners captured BUILD-time offsets — so the moment the
// columns island committed the modal's changed body, the tabs widget's reused listeners dispatched a
// container range that no longer existed, and no number of clicks could enter it. The modal is not
// special: any island commit that CHANGES the document (measured: typing two characters sufficed, while
// a same-length commit kept working) left every other layout widget's entry dead. The fix resolves the
// container's offsets at CLICK time (posAtDOM), so this asserts the exact reported sequence.
test("#527after a modal edit in one container, a click still enters the other", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `n527b-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(TWO_CONTAINERS);
  await sleep(1500);

  // Enter the columns island, open the nested Excalidraw's modal, change the scene, save.
  const macro = page.locator("[data-pane=preview] [data-testid=macro-excalidraw]").first();
  await macro.click();
  await sleep(900);
  await expect(page.locator(".cm-lp-slot-edit-island")).toHaveCount(1);
  await page.getByTestId("macro-edit").first().click();
  await expect(page.locator(".wks-macro-modal .excalidraw")).toBeVisible({ timeout: 20000 });
  const canvas = page.locator(".excalidraw canvas").first();
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(400);
  await page.keyboard.press("Control+a");
  await sleep(300);
  for (let i = 0; i < 6; i++) { await page.keyboard.press("ArrowRight"); await sleep(40); }
  await sleep(500);
  await page.getByTestId("macro-modal-save").click();
  await sleep(1000);

  // THE REGRESSION: one click on the tabs panel must open the TABS island. Before the fix the commit of
  // the columns island (a changed body → a real doc change) left the tabs widget's reused listeners
  // holding pre-shift offsets, and this stayed at zero forever.
  await page.locator("[data-pane=preview] .cm-lp-tabs .cm-lp-tabpanel-active").first().click();
  await sleep(900);
  const inTabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".cm-lp-slot-edit-island")).filter((i) => i.closest(".cm-lp-tabs")).length);
  expect(inTabs, "the tabs island opened after the modal edit above it").toBe(1);
});

// The same regression without the modal: the modal only mattered because it guarantees the island body
// CHANGES. A plain keyboard edit in the columns island broke the tabs entry identically, so the pin
// covers the cheaper path too — if either half regresses independently, one of these goes red.
test("#527after a keyboard edit in one container, a click still enters the other", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `n527c-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content >> nth=0");
  await page.keyboard.insertText(TWO_CONTAINERS);
  await sleep(1500);

  await page.locator("[data-pane=preview] .cm-lp-columns .cm-lp-column").first().click();
  await sleep(900);
  await expect(page.locator(".cm-lp-slot-edit-island")).toHaveCount(1);
  await page.keyboard.type("xx"); // dirty the island: its commit must CHANGE the doc to arm the bug
  await sleep(300);

  await page.locator("[data-pane=preview] .cm-lp-tabs .cm-lp-tabpanel-active").first().click();
  await sleep(900);
  const inTabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".cm-lp-slot-edit-island")).filter((i) => i.closest(".cm-lp-tabs")).length);
  expect(inTabs, "the tabs island opened after the edit above it").toBe(1);
});
