import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, setPublicSurface, sleep } from "../helpers";

// #505: print fidelity. (a) Callout icons/tints are painted with background-color/background — browser
// print drops "background graphics" by default, so the panel degraded to bare text + a left border;
// print-color-adjust: exact (inherited from the preview root) forces them. (b) The page title lives in
// the band OUTSIDE [data-pane=preview], so the print visibility trick dropped it from every print-out.
// Pinned as computed styles under print media emulation — the exact contract the print engine consumes.
const API = "http://dev.localhost:4010";

async function makePublic(id: string) {
  const r = await fetch(`${API}/pages/${id}/public`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ public: true }),
  });
  if (!r.ok) throw new Error(`makePublic ${r.status}`);
}

test("#505: under print media the title is visible and the callout keeps exact colour", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, `print505-${Date.now().toString(36)}`);
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText(":::note[Label]\ncallout body five oh five\n:::\n\nplain text\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(800);
  await makePublic(id);
  await setPublicSurface(authed, true);

  // ── the APP surface (in-app print) ──
  await authed.emulateMedia({ media: "print" });
  const appTitle = await authed.getByTestId("page-title").evaluate((el) => getComputedStyle(el).visibility);
  expect(appTitle, "in-app: the page title prints").toBe("visible");
  const appAdjust = await authed.locator(".cm-lp-callout-panel").first().evaluate((el) => {
    const cs = getComputedStyle(el) as CSSStyleDeclaration & { printColorAdjust?: string; webkitPrintColorAdjust?: string };
    return cs.printColorAdjust ?? cs.webkitPrintColorAdjust ?? "";
  });
  expect(appAdjust, "in-app: the callout panel forces exact colour").toBe("exact");

  // ── the PUBLIC reader (/pub) ──
  const anon = await (await browser.newContext()).newPage();
  await anon.goto(`/pub/${id}`);
  await expect(anon.getByText("callout body five oh five")).toBeVisible({ timeout: 10000 });
  await anon.emulateMedia({ media: "print" });
  const pubTitle = await anon.getByTestId("page-title").evaluate((el) => getComputedStyle(el).visibility);
  expect(pubTitle, "/pub: the page title prints").toBe("visible");
  const pubAdjust = await anon.locator(".cm-lp-callout-panel").first().evaluate((el) => {
    const cs = getComputedStyle(el) as CSSStyleDeclaration & { printColorAdjust?: string; webkitPrintColorAdjust?: string };
    return cs.printColorAdjust ?? cs.webkitPrintColorAdjust ?? "";
  });
  expect(pubAdjust, "/pub: the callout panel forces exact colour").toBe("exact");
});
