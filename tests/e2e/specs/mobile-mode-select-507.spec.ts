import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #507: the mobile ⋯ menu's display-mode row CYCLED on every tap and closed the menu, so reaching a
// mode took up to three open-tap-close rounds. It is now a submenu that LISTS the modes for direct
// selection (same idea as the desktop segment, ADR-056/#164). The pin selects a mode through the
// submenu and asserts the EDITOR actually switched (raw ::: syntax appears in Source), not just menu
// chrome.

const PHONE = { width: 390, height: 844 };
const content = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();

test("#507: the mobile menu lists the display modes and one tap switches directly", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `mode507-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::note\nnoted body line\n:::\n\nplain tail\n");
  await sleep(500);
  expect(await content(page), "live hides the ::: syntax").not.toContain(":::note");

  // shrink to phone — the controls re-render as the mobile ⋯ cluster, still editing
  await page.setViewportSize(PHONE);
  await expect(page.getByTestId("page-controls-mobile")).toBeVisible({ timeout: 10000 });

  await page.getByTestId("page-controls-mobile").click();
  await page.getByTestId("m-displaymode-toggle").click();
  await expect(page.getByTestId("m-displaymode-menu"), "the modes are LISTED, not cycled").toBeVisible({ timeout: 8000 });
  // all four modes are offered with the current one marked
  for (const m of ["live", "source", "reading", "wysiwyg"]) {
    await expect(page.getByTestId(`m-displaymode-${m}`)).toBeVisible();
  }
  await page.getByTestId("m-displaymode-source").click();
  await sleep(400);

  // the EDITOR switched: Source shows the raw directive fence
  expect(await content(page), "one tap landed in Source").toContain(":::note");

  // the submenu reflects the new current mode when reopened
  await page.getByTestId("page-controls-mobile").click();
  await page.getByTestId("m-displaymode-toggle").click();
  await expect(page.getByTestId("m-displaymode-menu")).toBeVisible({ timeout: 8000 });
  await expect(page.getByTestId("m-displaymode-source").locator("svg.lucide-check"), "the check marks the current mode").toBeVisible();
});
