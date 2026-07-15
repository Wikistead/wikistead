import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, resetDoc, sleep } from "../helpers";

// #381 / ADR-163 §2: the computed-style PARITY PIN between the two markdown vocabularies, in a REAL
// browser (happy-dom has no layout engine). The CM surface renders `.cm-lp-*` line decorations; a nested
// macro body renders raw tags inside a `.wks-prose` container (the ONE prose sheet). Both consume the
// same value tokens — if either side stops, this goes red instead of a device finding (#335/#351 class).
test("#381: nested (.wks-prose) prose matches the CM vocabulary — headings + code box; .cm-content never wears .wks-prose", async ({ page }) => {
  await openScratch(page, "Prose Parity 381");
  await enterEdit(page);
  await resetDoc(page);
  // insertText (no key handlers) — the exact pattern block-interaction-174 uses for column fixtures.
  await page.keyboard.insertText("# Top\n\nsome `inline` text\n\n::::columns\n:::column\n# Inside\n\nnested `code` here\n\n```\nfence\n```\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n");
  await sleep(800);

  // the container got the class at the emission point
  const col = page.locator(".cm-lp-column.wks-prose").first();
  await expect(col).toBeVisible({ timeout: 5000 });

  // 1) heading parity: the nested raw <h1> font-size equals the CM .cm-lp-h1 computed size (same token)
  const cmH1 = await page.$eval(".cm-lp-h1", (el) => getComputedStyle(el).fontSize);
  const nestedH1 = await col.locator("h1").first().evaluate((el) => getComputedStyle(el).fontSize);
  expect(nestedH1).toBe(cmH1);

  // 2) the #351 class regression: nested inline code + fence get a REAL box (background + radius)
  const codeBg = await col.locator("code").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(codeBg).not.toBe("rgba(0, 0, 0, 0)"); // not transparent
  const preBg = await col.locator("pre").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(preBg).not.toBe("rgba(0, 0, 0, 0)");
  // and it matches the CM inline-code box (the shared token, resolved to the same computed color)
  const cmCodeBg = await page.$eval(".cm-lp-inline-code", (el) => getComputedStyle(el).backgroundColor);
  expect(codeBg).toBe(cmCodeBg);

  // 3) the ADR-163 over-application invariant: the editor root NEVER wears .wks-prose
  expect(await page.$$eval(".cm-content.wks-prose", (els) => els.length)).toBe(0);
});
