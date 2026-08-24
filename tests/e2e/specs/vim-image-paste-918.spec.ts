import { expect, test, type Page } from "@playwright/test";
import { enterEdit, openScratch } from "../helpers";

const readDoc = (page: Page) => page.evaluate(() => {
  const editor = document.querySelector("[data-pane=preview] .cm-editor") as { cmView?: { view?: unknown } } | null;
  const content = document.querySelector("[data-pane=preview] .cm-content") as { cmTile?: { view?: unknown } } | null;
  const view = (editor?.cmView?.view ?? content?.cmTile?.view) as { state: { doc: { toString(): string } } };
  return view.state.doc.toString();
});

test("#918 Vim insert-mode Ctrl+V sends an image through native paste", async ({ page }) => {
  await openScratch(page, `vim-image-paste-918-${Date.now()}`);
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await expect(page.getByTestId("vim-toggle")).toHaveAttribute("aria-pressed", "true");

  await page.locator("[data-pane=preview] .cm-content").click();
  await page.keyboard.press("i");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __lpVimInsert?: boolean }).__lpVimInsert)).toBe(true);

  await page.evaluate(async () => {
    const encoded = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const png = new Blob([Uint8Array.from(atob(encoded), (byte) => byte.charCodeAt(0))], { type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  });
  await page.keyboard.press("Control+v");

  await expect.poll(() => readDoc(page), { timeout: 8_000 }).toContain("wks-attachment:");
});
