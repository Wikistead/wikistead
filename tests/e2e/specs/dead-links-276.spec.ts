import { test, expect } from "@playwright/test";
import { openScratch, createScratchPage, enterEdit, sleep } from "../helpers";

// #276 / ADR-117: an internal link `[text](/p/<id>)` whose target the viewer can't view (deleted, private,
// never existed) renders STRUCK-THROUGH (cm-lp-link-dead), so a reader sees it's dead before clicking; a
// viewable target stays normal. Display-only — the source is unchanged (Open formats) and the link stays
// clickable. authz: "dead" is a pure viewability answer (existence-hiding — a real private page and a made-up
// id are identical). Real Chromium (the batch resolve → async decoration is only observable in a browser).
test("#276: a dead internal link is struck through; a viewable one is not; source unchanged", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const alive = await createScratchPage(page, "Alive Target 276"); // dev-user created it → viewable

  await openScratch(page, "dead-link-host");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // Two internal links on their own lines, plus a trailing line so the caret rests OFF the link lines
  // (a caret on a link line would reveal its raw markdown).
  await page.keyboard.insertText(`[alive](/p/${alive})\n\n[dead](/p/does-not-exist-00000000)\n\nend\n`);
  await sleep(400);
  // move the caret to the last line, away from the links, so both links render (not raw)
  await page.keyboard.press("Control+End");
  await sleep(200);

  const deadMark = page.locator("[data-pane=preview] .cm-lp-link-dead");
  // the batch resolves asynchronously → poll for the dead mark to appear
  await expect.poll(async () => (await deadMark.count()) > 0, { timeout: 6000 }).toBe(true);
  await expect(deadMark).toHaveText("dead"); // the unviewable target is struck
  // the viewable link is NOT struck — no cm-lp-link-dead carries its text
  expect(await deadMark.allInnerTexts()).not.toContain("alive");

  // display-only: the canonical source is unchanged — revealing the dead link line shows its raw markdown.
  await page.locator("[data-pane=preview] .cm-content").getByText("dead", { exact: false }).first().click();
  await sleep(200);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("/p/does-not-exist-00000000");
});
