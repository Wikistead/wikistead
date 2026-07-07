import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #203 (resolved by #237): exact structure: callout(warning) → text → HEAVY excalidraw → text → info callout. Verify the
// FINAL info callout renders on initial load WITHOUT a click (the #237 fix should resolve this same root).
function heavyExcalidraw(): string {
  const elements = Array.from({ length: 45 }, (_, i) => ({
    type: i % 2 ? "ellipse" : "freedraw", id: `e${i}`, x: i * 12, y: i * 9, width: 100, height: 70, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, roughness: 1,
    opacity: 100, seed: i + 1, version: 1, versionNonce: i + 2, isDeleted: false, groupIds: [], frameId: null,
    boundElements: null, updated: 1, link: null, locked: false,
    points: i % 2 ? undefined : [[0,0],[10,10],[20,5],[30,20]],
  }));
  return "```excalidraw\n" + JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {} }) + "\n```";
}

test("#203: the info callout AFTER a heavy excalidraw renders on initial load (no click)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, "repro203");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const doc = [
    ":::warning\nheads up\n:::", "", "some text before", "", heavyExcalidraw(), "",
    "text after the drawing", "", ":::info\nthe LAST callout — must render on load\n:::",
  ].join("\n");
  await page.keyboard.insertText(doc + "\n");
  await sleep(1200);
  await page.getByTestId("publish-page").click();
  await sleep(1200);
  // fresh initial load (read → edit), NO clicks into content
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await enterEdit(page);
  await sleep(3000);
  // scroll to bottom (viewport virtualization is normal) then check the info callout is a rendered panel
  await page.evaluate(() => { const sc = document.querySelector(".cm-scroller") as HTMLElement; sc.scrollTop = sc.scrollHeight; });
  await sleep(1500);
  const infoPanel = page.locator("[data-pane=preview] .cm-lp-callout-panel", { hasText: "the LAST callout" });
  await expect(infoPanel).toBeVisible();
  const raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).not.toContain(":::info"); // not stuck as raw source
});
