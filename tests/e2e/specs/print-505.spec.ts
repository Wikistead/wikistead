import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, setPublicSurface, sleep, API } from "../helpers";

// #505: print fidelity + pagination. Every reading surface renders its body with CodeMirror, which
// VIRTUALISES its viewport — printing the live surface prints one screenful, crushed onto a single sheet.
// A body-level PrintSurface portal renders the FULL published Markdown statically; @media print hides the
// live app and shows only the portal in normal document flow, so long content paginates across sheets and
// the title / callout colours ride along. Pinned under print-media emulation + a real page.pdf().
async function makePublic(id: string) {
  const r = await fetch(`${API}/pages/${id}/public`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ public: true }),
  });
  if (!r.ok) throw new Error(`makePublic ${r.status}`);
}

test("#505: print shows the static portal (title + callout, exact colour) and hides the live app", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, `print505-${Date.now().toString(36)}`);
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText(":::note[Label]\ncallout body five oh five\n:::\n\nplain text\n");
  await sleep(400);
  await authed.getByTestId("publish-page").click();
  await sleep(1000);
  await makePublic(id);
  await setPublicSurface(authed, true);

  // off-print: the portal is inert (display:none)
  expect(await authed.locator("[data-print-root]").evaluate((el) => getComputedStyle(el).display), "off-print: portal hidden").toBe("none");

  await authed.emulateMedia({ media: "print" });
  await sleep(150);
  // in print: the portal is shown, the live app root (every body child except the portal) is hidden
  expect(await authed.locator("[data-print-root]").evaluate((el) => getComputedStyle(el).display), "print: portal shown").toBe("block");
  const appHidden = await authed.evaluate(() =>
    [...document.body.children]
      .filter((c) => !c.hasAttribute("data-print-root"))
      .every((c) => getComputedStyle(c).display === "none"),
  );
  expect(appHidden, "print: the live app root is display:none").toBe(true);
  // and the live CM surface is consequently not visible (ancestor hidden)
  expect(await authed.locator("[data-pane=preview]").first().isVisible(), "print: live surface not visible").toBe(false);
  // the title prints (inside the portal) and the callout body is present in the static render
  await expect(authed.getByTestId("print-title"), "the title prints").toHaveText(/print505/);
  await expect(authed.locator("[data-print-root]"), "the callout body prints").toContainText("callout body five oh five");
  // colour fidelity is forced on the portal root (inherits to the callout icon/tint)
  const adjust = await authed.locator("[data-print-root]").evaluate((el) => {
    const cs = getComputedStyle(el) as CSSStyleDeclaration & { printColorAdjust?: string; webkitPrintColorAdjust?: string };
    return cs.printColorAdjust ?? cs.webkitPrintColorAdjust ?? "";
  });
  expect(adjust, "the portal forces exact colour").toBe("exact");
});

// #505a document longer than one sheet must PAGINATE (was crushed to one page + a printed
// scrollbar, because the live CM body is virtualised). The static portal holds the whole document, so a
// real page.pdf() spans multiple sheets and the LAST paragraph is present.
test("#505a long page paginates across multiple sheets with the full content", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, `print505long-${Date.now().toString(36)}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  let md = "# Long\n\nMARKER_TOP first.\n\n";
  for (let i = 0; i < 120; i++) md += `Paragraph ${i}: the quick brown fox jumps over the lazy dog to fill the sheet.\n\n`;
  md += "MARKER_BOTTOM final.\n";
  await page.keyboard.insertText(md);
  await sleep(600);
  await page.getByTestId("publish-page").click();
  await sleep(1200);

  // the portal holds the WHOLE document (both the first and the LAST marker — the live CM would virtualise
  // one of them out of the DOM)
  const body = page.locator("[data-print-root] [data-testid=print-body]");
  await expect(body).toContainText("MARKER_TOP");
  await expect(body).toContainText("MARKER_BOTTOM");

  // a real PDF spans multiple sheets (was 1 before the fix)
  const pdf = await page.pdf({ format: "A4" });
  const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
  expect(pages, "the long document paginated").toBeGreaterThan(1);
});
