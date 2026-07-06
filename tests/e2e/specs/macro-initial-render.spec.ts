import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #237 (and #203's excalidraw observation): blocks BELOW a heavy macro must render on the initial
// load WITHOUT any click. Root cause: a huge single-line fence (a complex excalidraw scene) exhausts
// the initial lezer parse budget mid-document; the language worker's progress dispatches carry no
// doc/selection change, and the livePreview field kept STALE decorations built from the partial
// tree — everything past the parse frontier stayed plain text until a selection change forced a
// rebuild ("renders when I click"). The field now rebuilds when the syntax tree object changes.
function heavyExcalidrawFence(): string {
  const elements = Array.from({ length: 40 }, (_, i) => ({
    type: "ellipse", id: `e${i}`, x: i * 15, y: i * 10, width: 120, height: 80, angle: 0,
    strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2,
    roughness: 1, opacity: 100, seed: i + 1, version: 1, versionNonce: i + 2, isDeleted: false,
    groupIds: [], frameId: null, boundElements: null, updated: 1, link: null, locked: false,
  }));
  return "```excalidraw\n" + JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {} }) + "\n```";
}

test("#237: macros below a heavy macro render on initial load WITHOUT a click", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const id = await openScratch(page, "macro-initial-render");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const doc = [
    ":::warning\nwarn TOP\n:::", "", "text para", "", heavyExcalidrawFence(), "",
    "text after", "", ":::info\ninfo AFTER-EXCALIDRAW\n:::", "",
    "```mermaid\ngraph TD; X-->Y;\n```", "", ":::tip\ntip LAST\n:::",
  ].join("\n");
  await page.keyboard.insertText(doc + "\n");
  await sleep(1200);
  await page.getByTestId("publish-page").click();
  await sleep(1200);

  // Fresh initial load of the EDIT surface (read → edit), NO clicks into the content after this.
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await enterEdit(page);
  await sleep(3000); // let the async parse progress; the fix rebuilds decorations as it grows

  // The callouts near/inside the viewport render as PANELS (no raw ::: text) — pre-fix this was 0
  // and the source stayed plain until a click.
  const panels = page.locator("[data-pane=preview] .cm-lp-callout-panel");
  expect(await panels.count()).toBeGreaterThan(0);
  await expect(panels.first()).toBeVisible();
  // The macro AFTER the heavy fence renders too (the reported victim), possibly after a scroll
  // (CM mounts widgets viewport-locally — that virtualization is normal and not the bug).
  await page.evaluate(() => { const sc = document.querySelector(".cm-scroller") as HTMLElement; sc.scrollTop = sc.scrollHeight; });
  await sleep(1200);
  const infoPanel = page.locator("[data-pane=preview] .cm-lp-callout-panel", { hasText: "info AFTER-EXCALIDRAW" });
  await expect(infoPanel).toBeVisible(); // rendered as a panel, not raw ::: source
  const raw = await page.locator("[data-pane=preview] .cm-content").innerText();
  expect(raw).not.toContain(":::info"); // no plain-text leftovers past the parse frontier
});
