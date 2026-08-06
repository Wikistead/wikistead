import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #633 / ADR-217: prose is proportional, vim brings the column grid, and nothing else changes.
//
// Measured as the FACE THAT PAINTS, not as the value of a CSS variable: `--font-body` is a chain, and
// which family in it actually renders is the browser's answer, not the stylesheet's. `document.fonts`
// is asked which faces were loaded, because "as light as possible" is a claim about bytes and
// the only honest reading of it is which files the browser fetched.
const bodyFace = () => `(() => {
  const el = document.querySelector('.cm-content');
  return el ? getComputedStyle(el).fontFamily : null;
})()`;

/** The families the browser actually pulled down, as opposed to the ones named in a stack. */
const loadedFamilies = () => `[...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))].sort()`;

test("#633: prose is proportional until vim asks otherwise", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "ja"); localStorage.removeItem("wks.editorVim"); } catch { /* private */ } });
  await openScratch(page, `fonts633-${Date.now()}`);
  await enterEdit(page);
  await sleep(1200);

  const off = await page.evaluate(bodyFace());
  expect(off, "the editing surface has a face at all").toBeTruthy();
  expect(off, "vim off: the same proportional chain the chrome uses").toContain("Inter");
  expect(off, "…and not the monospace grid").not.toContain("UDEV");

  // the marker, and then the face. Asserted in that order because the attribute is the contract and the
  // face is the consequence — if only the first moves, the stylesheet is wrong rather than the toggle.
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-vim-on", "");
    document.documentElement.setAttribute("data-vim-mono", "");
  });
  // the face arrives when the file does (`font-display: swap`), so this waits for the switch rather
  // than sampling immediately — measuring too early reads the old face and passes for the wrong reason
  await page.waitForFunction(`${bodyFace()}?.includes('UDEV')`, undefined, { timeout: 10_000 });
  const on = await page.evaluate(bodyFace());
  expect(on, "vim on: the column grid").toContain("UDEV");

  await page.evaluate(() => document.documentElement.removeAttribute("data-vim-mono"));
  await sleep(300);
  expect(await page.evaluate(bodyFace()), "and back again when it is turned off").toContain("Inter");
});

// The third claim — code stays monospace whatever vim does — is pinned in `FontProvider.test.ts`
// instead: the vim rules are required never to mention `--font-code`, which is the whole of it. An e2e
// was written first and could not find a code element to measure on the live surface (a fence is drawn
// by a widget), and a spec that skips is a claim nobody checks.

test("#633: the monospace face is not downloaded until vim asks for it", async ({ page }) => {
  test.setTimeout(180_000);
  // "as light as possible" is a claim about bytes. UDEV Gothic is ~1.6MB per weight, and before this
  // change every Japanese reader paid for it whether or not they used vim.
  await page.addInitScript(() => { try { localStorage.setItem("wks.lang", "ja"); localStorage.removeItem("wks.editorVim"); } catch { /* private */ } });
  await openScratch(page, `fonts633w-${Date.now()}`);
  await enterEdit(page);
  await sleep(1500);

  const atRest = (await page.evaluate(loadedFamilies())) as string[];
  expect(atRest.length, "some face was loaded (else this measures an empty page)").toBeGreaterThan(0);
  expect(atRest, `the vim grid was fetched with vim off :: ${JSON.stringify(atRest)}`)
    .not.toContain("UDEV Gothic");

  await page.evaluate(() => {
    document.documentElement.setAttribute("data-vim-on", "");
    document.documentElement.setAttribute("data-vim-mono", "");
  });
  await page.waitForFunction(`${loadedFamilies()}.includes('UDEV Gothic')`, undefined, { timeout: 15_000 })
    .catch(() => { /* asserted below with the list in the message */ });
  const afterVim = (await page.evaluate(loadedFamilies())) as string[];
  expect(afterVim, `asking for the grid should fetch it :: ${JSON.stringify(afterVim)}`).toContain("UDEV Gothic");
});
