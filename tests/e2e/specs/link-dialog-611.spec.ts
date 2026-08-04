import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #611 / ADR-211: links through a dialog in WYSIWYG. What is measured here is the DOOR behaviour a
// browser can see — the dialog opens, the doc is untouched until confirm, cancel is byte-identical,
// unlink from the dialog — while the tree-level assertions (nesting, shrapnel, scope rows) are the
// link-at unit pins (no dev probe exposes the syntax tree here).
const doc = (page: import("@playwright/test").Page) => page.locator("[data-pane=preview] .cm-content");

async function intoWysiwyg(page: import("@playwright/test").Page) {
  await openScratch(page);
  await enterEdit(page);
  await page.getByTestId("displaymode-wysiwyg").click();
  await sleep(200);
  await doc(page).click();
}

test("#611: insert via dialog — nothing written until confirm; cancel is byte-identical", async ({ page }) => {
  test.setTimeout(120_000);
  await intoWysiwyg(page);
  await page.keyboard.type("hello world");
  await sleep(200);
  // select "world", open the bubble's link door (the icon button, #612)
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.getByTestId("format-bubble").locator(".lp-btn-icon").click();
  await expect(page.getByTestId("link-dialog-url"), "the dialog opens instead of an invisible splice").toBeVisible();
  const before = await doc(page).innerText();
  // cancel: byte-identical document
  await page.getByTestId("link-dialog-cancel").click();
  await sleep(200);
  expect(await doc(page).innerText(), "cancel leaves the doc byte-identical").toBe(before);
  // again, and confirm this time
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.getByTestId("format-bubble").locator(".lp-btn-icon").click();
  await expect(page.getByTestId("link-dialog-text")).toHaveValue("world");
  await page.getByTestId("link-dialog-url").fill("https://example.com");
  await page.getByTestId("link-dialog-save").click();
  await sleep(300);
  // the finished link renders (WYSIWYG hides markup, so the visible text stays "world" as a link)
  await expect(doc(page).locator(".cm-lp-link", { hasText: "world" }), "the finished link renders").toBeVisible();
});

test("#611: empty/unsafe URL cannot confirm; edit prefills; unlink from the dialog", async ({ page }) => {
  test.setTimeout(120_000);
  await intoWysiwyg(page);
  await page.keyboard.type("read me now");
  await sleep(200);
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.getByTestId("format-bubble").locator(".lp-btn-icon").click();
  await expect(page.getByTestId("link-dialog-save"), "empty URL cannot confirm").toBeDisabled();
  await page.getByTestId("link-dialog-url").fill("javascript:alert(1)");
  await expect(page.getByTestId("link-dialog-save"), "an unsafe scheme cannot confirm (linkHref is the judge)").toBeDisabled();
  await expect(page.getByTestId("link-dialog-invalid")).toBeVisible();
  await page.getByTestId("link-dialog-url").fill("https://example.com/x");
  await page.getByTestId("link-dialog-save").click();
  await sleep(300);
  // cursor inside the link → the same door becomes EDIT, prefilled
  await doc(page).locator(".cm-lp-link").first().click();
  await sleep(150);
  await page.keyboard.press("Shift+ArrowRight");
  await page.getByTestId("format-bubble").locator(".lp-btn-icon").click();
  await expect(page.getByTestId("link-dialog-url"), "edit is prefilled from the node").toHaveValue("https://example.com/x");
  // unlink: the label survives, the link is gone
  await page.getByTestId("link-dialog-unlink").click();
  await sleep(300);
  await expect(doc(page), "the label survives").toContainText("now");
  await expect(doc(page).locator(".cm-lp-link"), "the link is gone").toHaveCount(0);
  await expect(doc(page), "no shrapnel").not.toContainText("](");
});
