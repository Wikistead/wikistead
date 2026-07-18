import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #452: on a reveal-on-cursor macro (callout, mermaid, ...), the Ctrl+↵ entry pill must stay
// visible for the WHOLE reveal — not only while the caret sits on the HEAD line. The old rule
// gated the pill on .cm-lp-macro-raw-head (caret-on-head), so moving the caret into the BODY
// hid the hint mid-edit. Now it gates on .cm-lp-macro-raw (present on the head line whenever the
// block is revealed). Real Chromium (computed opacity). Mouse parked away — no hover assist.
test("#452: the entry pill stays visible while the caret is on a BODY line of the reveal", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `pill452-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::warning\nbody line one\nbody line two\n:::\n\nbelow\n");
  await sleep(400);

  // Reveal: click INTO the rendered callout body → the raw ::: lines reveal with the caret on a
  // BODY line (the CalloutWidget parks entry on the body, therule).
  await page.getByText("body line one").click();
  await sleep(400);
  const raw = page.locator("[data-pane=preview] .cm-lp-macro-raw");
  await expect(raw).toHaveCount(1, { timeout: 5000 }); // revealed
  await page.mouse.move(2, 2); // park the pointer away — hover must not be what shows the pill
  await sleep(300);

  const pill = page.locator("[data-pane=preview] .cm-lp-macro-richui-raw").first();
  const onBody = Number(await pill.evaluate((el) => getComputedStyle(el).opacity));
  expect(onBody, `pill visible with the caret on a body line (opacity ${onBody})`).toBeGreaterThan(0.5);

  // Move DOWN within the body (still revealed) — the pill must not blink out.
  await page.keyboard.press("ArrowDown");
  await sleep(300);
  const onBody2 = Number(await pill.evaluate((el) => getComputedStyle(el).opacity));
  expect(onBody2, "still visible on the next body line").toBeGreaterThan(0.5);

  // Leave the block (caret on trailing text) → the reveal collapses and the hint goes with it.
  await page.getByText("below", { exact: true }).click();
  await sleep(500);
  await expect(page.locator("[data-pane=preview] .cm-lp-macro-raw")).toHaveCount(0, { timeout: 5000 });
});
