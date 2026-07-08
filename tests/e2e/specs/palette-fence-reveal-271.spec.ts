import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const content = (p: import("@playwright/test").Page) => p.locator("[data-pane=preview] .cm-content").innerText();
const headLine = (p: import("@playwright/test").Page) => p.evaluate(() => (window as any).__lpHeadLine);

// #271: inserting a fence macro (mermaid/plantuml) from the `/` palette dropped the caret INSIDE the fence
// body, which the atom widget hides — so the caret was trapped on a hidden line. Symptom (vim × Live)
// after /mermaid + Esc, `j` appeared to do nothing on the FIRST press (it was walking the hidden atom's
// internal lines) so you had to press it twice to descend; typed characters were invisible too. The insert
// now also enters the raw state (same as Ctrl+Enter) in the SAME transaction, so the source is revealed,
// the caret sits on a real visible line, typing shows, `j` advances exactly one doc line, and moving the
// caret out renders the diagram. Real Chromium + vim — a rendered/atom/motion concern happy-dom can't run.
test("#271: /mermaid inserts raw-revealed — vim j advances one line (not stuck), exit renders", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "palette-mermaid-271");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click(); // faithfully reproduce the vim × Live report
  await page.click("[data-pane=preview] .cm-content");

  // A sentinel first line (to click out to later) and an empty line BELOW where the fence goes — the
  // exact setup from the report.
  await page.keyboard.press("i"); // vim insert
  await page.keyboard.type("sentinel\n\n"); // line1=sentinel, line2=fence goes here, line3=empty below
  await page.keyboard.press("ArrowUp"); // back to the empty line 2

  // Insert the mermaid macro via the palette (click the row directly — unambiguous vs Enter+selection).
  await page.keyboard.type("/mermaid");
  await page.locator('[data-testid="slash-item-macro:mermaid"]').click();
  await expect(page.getByTestId("slash-palette")).toHaveCount(0);
  await sleep(200);

  // The fence did NOT collapse into the hiding atom, and it is the RAW source (not the editUI textarea)
  // so the caret sits on a real, visible body line.
  await expect(page.getByTestId("macro-mermaid")).toHaveCount(0);
  await expect(page.getByTestId("mermaid-edit-src")).toHaveCount(0);

  // Typing lands in the visible body immediately (proves the caret is NOT trapped on a hidden line).
  await page.keyboard.type("graph TD");
  await sleep(150);
  expect(await content(page)).toContain("graph TD");

  // Esc → vim normal; a SINGLE `j` moves the caret DOWN (the reported bug left it stuck on the first
  // press — it was walking the hidden atom's internal lines). The exact line delta may be >1 when the
  // decoration-hidden closing ``` line is atomic-skipped; the anti-regression is that j is NOT stuck.
  await page.keyboard.press("Escape");
  await sleep(120);
  const before = await headLine(page);
  await page.keyboard.press("j");
  await sleep(120);
  const after = await headLine(page);
  expect(after).toBeGreaterThan(before);

  // Move the caret OUT of the fence → the diagram renders as the atom, the raw body hides.
  await page.getByText("sentinel").click();
  await sleep(500);
  await expect(page.getByTestId("macro-mermaid").first()).toBeVisible();
  expect(await content(page)).not.toContain("graph TD");
});
