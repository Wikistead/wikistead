import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep, publishAndWait } from "../helpers";

// #207: the Print item was GRAYED OUT because both print paths were low-fidelity — the live surface is
// virtualised (only a screenful printed) and the static one leaked raw `:::` and un-rendered math.
// ADR-191 rebuilt the render core: printing now goes through the SAME server-rendered document the HTML
// export serves. These pin that the item is actually usable again and that it takes that path — an
// enabled menu entry that silently printed the old surface would be worse than the seal.
const BODY = `# Print me

:::note[Labelled]
callout body
:::

- [x] a finished task
- [ ] an unfinished one

Inline math $E = mc^2$ and a table:

| A | B |
|---|---|
| 1 | 2 |

tail
`;

test("#207: the Print menu item is enabled again", async ({ page }) => {
  const id = await openScratch(page, `print207-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(BODY);
  await page.getByText("tail", { exact: true }).click();
  await sleep(600);
  await publishAndWait(page, id, "Print me");

  await page.getByTestId("page-overflow-trigger").click();
  const item = page.getByTestId("print-page");
  await expect(item, "the print entry is offered").toBeVisible({ timeout: 8000 });
  // the seal was a `disabled` item carrying a hint; neither may be back
  await expect(item).not.toHaveAttribute("data-disabled", /.*/);
  await expect(item).toBeEnabled();
});

test("#207: printing renders the export document, not the virtualised live surface", async ({ page }) => {
  const id = await openScratch(page, `print207b-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(BODY);
  await page.getByText("tail", { exact: true }).click();
  await sleep(600);
  await publishAndWait(page, id, "Print me");

  // Capture what gets printed. Printing builds the export document into an offscreen iframe and calls
  // print() on THAT window (#85 / ADR-194 slice 2 — the document is assembled in the browser rather than
  // fetched, but it is still the export document, never the CodeMirror surface). Stubbing print on every
  // frame lets us read the document that was about to go to paper.
  await page.addInitScript(() => {
    const w = window as unknown as { print: () => void; __printedHtml?: string };
    w.print = () => { w.__printedHtml = document.documentElement.outerHTML; };
  });
  await page.reload();
  // Wait for the PUBLISHED body to be in hand before printing. The handler falls back to printing the live
  // surface when it has no published markdown yet, so clicking too early measures the fallback rather than
  // the feature — which is exactly what the last assertion below catches.
  await expect(page.getByText("tail", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await sleep(1500);

  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("print-page").click();

  // the printed document is the export one: its body carries the RENDERED constructs, and none of the
  // raw markers that made printing unusable enough to seal the menu item.
  const printed = await page.waitForFunction(() => {
    for (const f of [...document.querySelectorAll("iframe")]) {
      const w = f.contentWindow as unknown as { __printedHtml?: string } | null;
      if (w?.__printedHtml) return w.__printedHtml;
    }
    return null;
  }, undefined, { timeout: 15_000 }).then((h) => h.jsonValue() as Promise<string>);

  expect(printed.length, "something was handed to the printer").toBeGreaterThan(0);
  expect(printed, "the callout is rendered, not a raw directive").not.toMatch(/:::note/);
  expect(printed, "the checklist is a checkbox, not a literal marker").not.toMatch(/\[[ xX]\] a finished/);
  expect(printed, "math is rendered, not raw TeX").not.toContain("$E = mc^2$");
  // The document is the standalone export, not the app: it carries the page title and none of the app
  // chrome. (Rendered `cm-lp-*` class names DO survive into it by design — ADR-194 builds the export from
  // the DOM the browser already drew — so their presence is not the discriminator; the chrome is.)
  expect(printed, "the export document is titled after the page").toContain("Print me");
  expect(printed, "and carries none of the app chrome").not.toContain("page-overflow-trigger");
});
