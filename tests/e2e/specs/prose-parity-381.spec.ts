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

// #381 (review return): the earlier pin was too shallow (h1 + inline-code only) and let five
// real diffs through — fence copy button missing, fence box look, table th-bg, td padding, and zero
// block spacing. This pins the DEEP parity: top-level CM fence/table vs the nested static render.
test("#381 nested fence + table match the top-level CM surface (copy button, box, th-bg, cell padding, spacing)", async ({ page }) => {
  await openScratch(page, "Prose Parity 381 deep");
  await enterEdit(page);
  await resetDoc(page);
  await page.keyboard.insertText(
    "```js\nconst x = 1;\n```\n\n| H1 | H2 |\n| --- | --- |\n| a | b |\n\n::::columns\n:::column\n```js\nconst x = 1;\n```\n\n| H1 | H2 |\n| --- | --- |\n| a | b |\n:::\n:::column\nplain\n:::\n::::\n\nbelow\n");
  await page.getByText("below", { exact: true }).click(); // caret OUT of every block → all render
  await sleep(800);

  const col = page.locator(".cm-lp-column.wks-prose").first();
  await expect(col).toBeVisible({ timeout: 5000 });

  // 1) STRUCTURAL: the nested fence has the SAME header — copy button + lang tab (was: bare <pre>)
  await expect(col.locator(".cm-lp-code-copy")).toHaveCount(1);
  await expect(col.locator(".cm-lp-code-lang")).toHaveText("js");
  // top-level twin for reference (the CM FenceHeaderWidget)
  const topCopy = page.locator(".cm-content > .cm-line .cm-lp-code-copy, .cm-lp-code-header .cm-lp-code-copy").first();
  await expect(topCopy).toBeVisible();

  // 2) fence BOX parity: nested pre bg/radius equal the CM code card (shared tokens)
  const topLine = page.locator(".cm-lp-code-line").first();
  const topBg = await topLine.evaluate((el) => getComputedStyle(el).backgroundColor);
  const topRadius = await page.locator(".cm-lp-code-first").first().evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
  const pre = col.locator("pre").first();
  expect(await pre.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(topBg);
  expect(await pre.evaluate((el) => getComputedStyle(el).borderRadius)).toBe(topRadius);

  // 3) table parity: th background is the REAL panel token (not a grey wash), equal both sides
  const topTh = page.locator(".cm-lp-table th").first();
  const nestedTh = col.locator(".cm-lp-md-table th").first();
  const topThBg = await topTh.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await nestedTh.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(topThBg);

  // 4) cell dimensions: td padding + font-size equal both sides
  const topTd = page.locator(".cm-lp-table td").first();
  const nestedTd = col.locator(".cm-lp-md-table td").first();
  expect(await nestedTd.evaluate((el) => getComputedStyle(el).padding)).toBe(await topTd.evaluate((el) => getComputedStyle(el).padding));
  expect(await nestedTd.evaluate((el) => getComputedStyle(el).fontSize)).toBe(await topTd.evaluate((el) => getComputedStyle(el).fontSize));

  // 5) block spacing: the nested fence and table are SEPARATED (were flush, gap 0) — within a few px of
  // the top-level gap (one blank source line in CM)
  const nestedFence = col.locator(".cm-lp-fence-card").first();
  const fenceBox = (await nestedFence.boundingBox())!;
  const tableBox = (await col.locator(".cm-lp-md-table").first().boundingBox())!;
  const nestedGap = tableBox.y - (fenceBox.y + fenceBox.height);
  expect(nestedGap, "fence and table no longer flush").toBeGreaterThan(6);
  const topFenceLast = (await page.locator(".cm-lp-code-last").first().boundingBox())!;
  const topTable = (await page.locator(".cm-lp-table").first().boundingBox())!;
  const topGap = topTable.y - (topFenceLast.y + topFenceLast.height);
  expect(Math.abs(nestedGap - topGap), `nested gap ${nestedGap} ≈ top gap ${topGap}`).toBeLessThanOrEqual(8);
});
