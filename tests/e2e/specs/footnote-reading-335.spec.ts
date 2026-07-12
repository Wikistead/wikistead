import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #335on a READ surface (Reading — a member's own read view) footnotes must AGGREGATE to a
// document-end section with numbered refs, `↩` back-links, and jump — matching the public reader. The EDIT
// surface keeps the definitions in place (edit them where they are). Real Chromium (the aggregation is a
// read-only decoration + an end-of-document block widget; the jump uses CM scrollIntoView).
test("#335: footnotes aggregate + jump in Reading; edit surface keeps them in place", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fn-reading");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("Intro with a note[^1] and another[^2].\n\nMore body text here.\n\n[^1]: the first note\n[^2]: the second note\n");
  await sleep(400);

  const content = page.locator("[data-pane=preview] .cm-content");
  const section = page.locator("[data-pane=preview] [data-testid=footnotes]");
  // EDIT surface: definitions render in place (muted), NOT aggregated — there is no end section.
  expect(await content.innerText()).toContain("the first note"); // def visible in place
  await expect(section).toHaveCount(0);

  // Switch to Reading (read-only) → the footnotes aggregate.
  await page.getByTestId("displaymode-reading").click();
  await sleep(500);
  await expect(section).toBeVisible();
  await expect(section.locator("li#fn-1")).toContainText("the first note");
  await expect(section.locator("li#fn-2")).toContainText("the second note");
  await expect(page.locator("[data-pane=preview] [data-testid=footnote-ref-1]")).toHaveText("1");
  const reading = await content.innerText();
  expect(reading).not.toContain("[^1]:"); // the raw def line is hidden (aggregated to the end)
  expect(reading).toContain("the first note"); // ...but present in the section
  // the `↩` back-links exist on the numbered items.
  await expect(section.locator("li#fn-1 .cm-lp-footnote-back")).toBeVisible();

  // Jump: clicking a numbered ref scrolls without error and the section stays reachable.
  await page.locator("[data-pane=preview] [data-testid=footnote-ref-1]").click();
  await sleep(200);
  await expect(section.locator("li#fn-1")).toBeVisible();

  // Back to edit → the aggregation is gone, definitions are in place again (non-regression).
  await page.getByTestId("displaymode-live").click();
  await sleep(400);
  await expect(section).toHaveCount(0);
  expect(await content.innerText()).toContain("the first note");
});
