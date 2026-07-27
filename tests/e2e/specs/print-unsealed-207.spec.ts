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

  await page.getByTestId("page-more").click();
  const item = page.getByTestId("print-page");
  await expect(item, "the print entry is offered").toBeVisible({ timeout: 8000 });
  // the seal was a `disabled` item carrying a hint; neither may be back
  await expect(item).not.toHaveAttribute("data-disabled", /.*/);
  await expect(item).toBeEnabled();
});

test("#207: printing fetches the server-rendered document (not the virtualised live surface)", async ({ page }) => {
  const id = await openScratch(page, `print207b-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(BODY);
  await page.getByText("tail", { exact: true }).click();
  await sleep(600);
  await publishAndWait(page, id, "Print me");

  // stub the print dialog so the run is not blocked by the browser's modal
  await page.addInitScript(() => { (window as unknown as { print: () => void }).print = () => {}; });
  await page.reload();
  await sleep(800);

  const exportHit = page.waitForRequest((r) => r.url().includes(`/pages/${id}/export.html`), { timeout: 10_000 });
  await page.getByTestId("page-more").click();
  await page.getByTestId("print-page").click();
  const req = await exportHit;
  expect(req.url(), "print goes through the single server renderer").toContain("export.html");

  // …and what that document contains is the parity substance: rendered callout, checkboxes, math, table —
  // the very things that used to print as raw text and were the reason for the seal.
  const body = await page.evaluate(async ({ id }) => {
    const r = await fetch(`/api/pages/${id}/export.html`, { credentials: "include" });
    return r.ok ? await r.text() : "";
  }, { id });
  expect(body.length, "the export document was served").toBeGreaterThan(0);
  const doc = { has: (s: string) => body.includes(s) };
  expect(doc.has("callout"), "the callout is rendered, not raw :::").toBe(true);
  expect(body, "no raw directive marker leaks into the printed document").not.toMatch(/:::note/);
  expect(doc.has('type="checkbox"'), "checklists are checkboxes").toBe(true);
  expect(body, "and no literal task marker survives").not.toMatch(/\[[ xX]\] a finished/);
  expect(doc.has("<table"), "the table is a table").toBe(true);
  expect(body, "math is rendered, not left as raw TeX").not.toContain("$E = mc^2$");
});
