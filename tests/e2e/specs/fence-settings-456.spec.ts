import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #456 S4: the code fence's declared settings, mounted. The macro says which controls exist and how
// to read and write its info string (fence-settings.ts); the host renders them in CodeMirror's
// tooltip layer — a panel parented to the block would be reconciled away on the next update.

const docText = (p: Page) => p.evaluate(() => {
  const ed = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const view = (ed?.cmView?.view ?? (document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null)?.cmTile?.view) as
    { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});

async function openPanel(page: Page) {
  await page.getByText("const a = 1", { exact: true }).click({ button: "right" });
  await expect(page.getByTestId("ctx-item-codesettings")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("ctx-item-codesettings").click();
  await expect(page.getByTestId("fence-settings-panel")).toBeVisible({ timeout: 8000 });
}

test("#456 S4: the settings panel writes the standard info string, leaving the body alone", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `fence456-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```ts\nconst a = 1\n```\n\nbelow\n");
  await sleep(600);

  await openPanel(page);

  // the controls are seeded from the macro's own read()
  await expect(page.getByTestId("macro-setting-lang")).toHaveValue("ts");
  await expect(page.getByTestId("macro-setting-showLineNumbers")).not.toBeChecked();

  // a change goes through the macro's write() and lands as one edit of the opening line
  await page.getByTestId("macro-setting-title").fill("app.ts");
  await page.getByTestId("macro-setting-title").blur();
  await sleep(300);
  await page.getByTestId("macro-setting-showLineNumbers").check();
  await sleep(400);

  const doc = await docText(page);
  expect(doc, "the info string carries the standard attributes").toContain('```ts title="app.ts" showLineNumbers');
  expect(doc, "the body is untouched").toContain("const a = 1");
  expect(doc.split("\n").filter((l) => l.startsWith("```")), "still exactly one fence pair").toHaveLength(2);
});

test("#456 S4: the panel survives a document change — it is in the tooltip layer, not the block", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `fence456b-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```ts\nconst a = 1\n```\n\nbelow\n");
  await sleep(600);

  await openPanel(page);
  // a setting write IS a document change — the panel must still be there afterwards, which is the
  // whole reason it lives in the tooltip layer
  await page.getByTestId("macro-setting-showLineNumbers").check();
  await sleep(500);
  await expect(page.getByTestId("fence-settings-panel"), "the panel outlived the edit it made").toBeVisible();

  // and it closes when asked
  await page.getByText("const a = 1", { exact: true }).click({ button: "right" });
  await page.getByTestId("ctx-item-codesettings").click();
  await sleep(300);
  await expect(page.getByTestId("fence-settings-panel")).toHaveCount(0);
});

// #456item 2: a keyboard path (Mod-Alt-Enter) and a hover ✎ open the same panel — right-click was
// the only way in. item 3: the panel can be closed with the × button and with Escape.
test("#456the settings open from the keyboard and from a hover ✎, and close via × and Escape", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `fence456c-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```ts\nconst a = 1\n```\n\nbelow\n");
  await sleep(600);

  // item 2 (keyboard): caret in the fence body → Mod-Alt-Enter opens the panel
  await page.getByText("const a = 1", { exact: true }).click();
  await page.keyboard.press("Control+Alt+Enter");
  await expect(page.getByTestId("fence-settings-panel"), "keyboard opened the settings").toBeVisible({ timeout: 8000 });

  // item 3 (Escape): focus lands in the panel on a keyboard open, so Escape closes it
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fence-settings-panel"), "Escape closed the settings").toHaveCount(0);

  // item 2 (hover ✎): hovering the fence shows the ✎ button, whose click opens the panel. Move in steps
  // (not a single .hover() jump) so CodeMirror's mousemove-driven hover detection registers.
  await page.mouse.move(2, 2);
  await sleep(150);
  const codeBox = (await page.getByText("const a = 1", { exact: true }).boundingBox())!;
  await page.mouse.move(codeBox.x + 5, codeBox.y + codeBox.height / 2, { steps: 6 });
  const hint = page.getByTestId("fence-settings-hint");
  await expect(hint, "the hover ✎ affordance appears on a code fence").toBeVisible({ timeout: 8000 });
  await hint.click();
  await expect(page.getByTestId("fence-settings-panel"), "the ✎ opened the settings").toBeVisible({ timeout: 8000 });

  // item 3 (× button): the explicit close dismisses it
  await page.getByTestId("fence-settings-close").click();
  await expect(page.getByTestId("fence-settings-panel"), "the × closed the settings").toHaveCount(0);
});
