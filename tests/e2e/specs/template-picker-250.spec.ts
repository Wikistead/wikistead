import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";
import { TORTURE_PAGE as TORTURE } from "../fixtures/torture-page";

// #267: the REAL standing QA torture-page body. The synthetic heavy fixture below passed while THIS
// body still burst the picker's two-pane row out of the dialog, so the geometry tests must use the
// real thing.

// #250 / ADR-110: create a page FROM a template via the sidebar split- ▾ picker. Save a page as a
// personal template, open the picker, preview it, and create — the new draft opens in edit seeded with the
// template body and titled by the template name. Real Chromium.
test("#250: the template picker creates a page seeded from the template", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const src = await openScratch(page, `pick-src-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Retro template\n\n- went well\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  // Save it as a personal template.
  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await page.getByTestId("template-name").fill("Retro Template");
  await page.getByTestId("save-template-submit").click();
  await sleep(500);

  // Open the picker from the sidebar split- ▾, preview, and use it.
  await page.getByTestId("new-page-from-template").click();
  await page.waitForSelector("[data-testid=template-picker]");
  const item = page.getByTestId("template-picker-item").filter({ hasText: "Retro Template" }).first();
  await expect(item).toBeVisible({ timeout: 8000 });
  await item.click();
  // The preview is the editor's own read-only CM surface (#267) — the heading is a styled line.
  await expect(page.getByTestId("template-picker-preview-body").locator(".cm-content")).toContainText("Retro template", { timeout: 8000 });
  await page.getByTestId("template-picker-use").click();

  // A new draft opens in edit, seeded with the template body.
  await page.waitForURL(/\/p\/.*edit=1/, { timeout: 8000 });
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(500);
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("Retro template");
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("went well");
});

// #366: the template picker now shares the embed/page-link picker keyboard model — the FIRST candidate is
// auto-highlighted (so Enter confirms without arrowing → the preview follows), and Ctrl-j/k / arrows move the
// highlight over the flattened list. Real Chromium (the auto-select + keyboard nav are runtime behaviours).
test("#366: the template picker auto-selects the first item and Enter confirms it (keyboard nav)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const src = await openScratch(page, `pick-kbd-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Keyboard template\n\n- first item\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await page.getByTestId("template-name").fill("Keyboard Template");
  await page.getByTestId("save-template-submit").click();
  await sleep(500);

  await page.getByTestId("new-page-from-template").click();
  await page.waitForSelector("[data-testid=template-picker]");
  // the first candidate is auto-highlighted (no click) → its preview renders and Enter can confirm it.
  const first = page.getByTestId("template-picker-item").first();
  await expect(first).toBeVisible({ timeout: 8000 });
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("template-picker-preview-body").locator(".cm-content")).toContainText("Keyboard template", { timeout: 8000 });
  // Enter (no click on the Use button) creates the page from the auto-highlighted template.
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/p\/.*edit=1/, { timeout: 8000 });
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(500);
  await expect(page.locator("[data-pane=preview] .cm-content")).toContainText("Keyboard template");
});

// #267: the picker preview mounts the EDITOR'S OWN read-only CM surface (mountPublishedView), so it
// renders structurally identical to a real page — math (KaTeX), a todo checkbox (display-only), syntax
// highlighting, line WRAPPING, a callout panel, mermaid centering, nested :::tabs and a :::table all come
// from the same engine. XSS stays inert (a <script> block and an <img onerror> in a table cell are text /
// escaped cells in that engine). The CM view is virtualised, so the probe SCROLLS through the document the
// way a user would (a seek helper) instead of expecting the whole body in the DOM at once.
test("#267: template preview renders with the editor engine (math/todo/highlight/wrap/macros) and stays XSS-safe", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 720 } })).newPage();
  const src = await openScratch(page, `pick267-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  const long = Array.from({ length: 40 }, (_, i) => `Paragraph line ${i} lorem ipsum dolor sit amet.`).join("\n\n");
  const wideCols = Array.from({ length: 12 }, (_, i) => `Col ${i}`).join(" | ");
  const wideSep = Array.from({ length: 12 }, () => "---").join(" | ");
  const wideRow = Array.from({ length: 12 }, (_, i) => `v${i}`).join(" | ");
  const wide = `| ${wideCols} |\n| ${wideSep} |\n| ${wideRow} |`;
  const wrapProbe = `WRAPPROBE ${Array.from({ length: 60 }, () => "wrapword").join(" ")}`;
  await page.keyboard.insertText(
    `# Macro template\n\n$$a^2 + b^2 = c^2$$\n\n- [ ] preview task\n\n\`\`\`js\nconst answer = 42;\n\`\`\`\n\n${wrapProbe}\n\n:::note\nHello **bold** callout\n:::\n\n\`\`\`mermaid\nflowchart TD\n  A --> B\n\`\`\`\n\n::::tabs\n:::tab[One]\nAlpha\n:::\n:::tab[Two]\nBravo\n:::\n::::\n\n:::table\n<table><tr><td><img src=x onerror="window.__xss267=1"></td></tr></table>\n:::\n\n${wide}\n\n<script>window.__xss267=1</script>\n\n${long}\n`,
  );
  await sleep(500);
  await page.getByTestId("publish-page").click();
  await sleep(700);

  await page.goto(`/p/${src}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.getByTestId("page-overflow-trigger").click();
  await page.getByTestId("save-template-open").click();
  await page.getByTestId("template-name").fill("Macro Template");
  await page.getByTestId("save-template-submit").click();
  await sleep(500);

  await page.getByTestId("new-page-from-template").click();
  await page.waitForSelector("[data-testid=template-picker]");
  await page.getByTestId("template-picker-item").filter({ hasText: "Macro Template" }).first().click();
  const preview = page.getByTestId("template-picker-preview-body");
  await expect(preview.locator(".cm-content")).toContainText("Macro template", { timeout: 8000 });
  await sleep(400); // async widgets (katex/mermaid) settle

  // Scroll the CM scroller one viewport at a time until `sel` is rendered (virtualised doc), collecting
  // the rendered text along the way so the "no raw ::: markers" check covers the whole document.
  const seenText: string[] = [];
  const seek = async (sel: string) => {
    for (let i = 0; i <= 14; i++) {
      seenText.push(await preview.innerText());
      if ((await preview.locator(sel).count()) > 0) return;
      const atEnd = await preview.locator(".cm-scroller").evaluate((sc) => {
        const before = sc.scrollTop;
        sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.8, sc.scrollHeight);
        return sc.scrollTop === before;
      });
      await sleep(300);
      if (atEnd) return;
    }
  };

  // (a) ENGINE PARITY — math renders as KaTeX, the todo checkbox exists but is DISABLED (display-only),
  // the js fence is syntax-highlighted (the `const` token paints differently from base text), and the
  // long paragraph WRAPS (its line is at least two text rows tall — EditorView.lineWrapping).
  await expect(preview.locator(".katex").first()).toBeVisible({ timeout: 8000 });
  const box = preview.getByTestId("task-checkbox").first();
  await expect(box).toBeVisible();
  await expect(box).toBeDisabled();
  const colors = await preview.evaluate((root) => {
    const spans = Array.from(root.querySelectorAll(".cm-line span"));
    const constSpan = spans.find((s) => s.textContent === "const");
    const base = root.querySelector(".cm-content");
    return { c: constSpan ? getComputedStyle(constSpan).color : null, base: base ? getComputedStyle(base).color : null };
  });
  expect(colors.c, "the `const` keyword has no highlight span").not.toBeNull();
  expect(colors.c, "code is not syntax-highlighted (keyword = base colour)").not.toBe(colors.base);
  const wrapGeom = await preview.evaluate((root) => {
    const line = Array.from(root.querySelectorAll(".cm-line")).find((l) => l.textContent?.includes("WRAPPROBE"));
    if (!line) return null;
    const lh = parseFloat(getComputedStyle(line).lineHeight) || 24;
    return { h: line.getBoundingClientRect().height, lh, right: line.getBoundingClientRect().right, paneRight: root.getBoundingClientRect().right };
  });
  expect(wrapGeom, "wrap probe line not rendered").not.toBeNull();
  expect(wrapGeom!.h, "long text does not wrap (single row)").toBeGreaterThan(wrapGeom!.lh * 1.8);
  expect(wrapGeom!.right, "wrapped text overflows the pane").toBeLessThanOrEqual(wrapGeom!.paneRight + 1);

  // (b) MACROS in the same engine — callout panel with recursed bold + box (tint + colour bar), mermaid
  // centred (the editor's own cm-lp-macro-wrap align class), nested tabs with both labels, a real table.
  await seek("[data-testid=callout-panel]");
  await expect(preview.locator("[data-testid=callout-panel]")).toHaveCount(1);
  await expect(preview.locator("[data-testid=callout-panel] strong")).toHaveText("bold");
  const calloutBg = await preview.locator("[data-testid=callout-panel]").evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, bar: cs.backgroundImage };
  });
  expect(calloutBg.bg, "callout panel has no background tint").not.toBe("rgba(0, 0, 0, 0)");
  expect(calloutBg.bg).not.toBe("transparent");
  // #632: the bar is PAINTED, not bordered — a `border-left` does not follow the panel's
  // `border-radius` and cut across the rounded corner, so it became a background gradient. Reading
  // `borderLeftWidth` measured the mechanism that was replaced and returned 0 while the bar was on
  // screen. `public-page.spec.ts` had the same assertion and the same wrong answer.
  expect(calloutBg.bar, "callout panel has no left colour bar").toMatch(/linear-gradient\(.*rgb/);

  await seek(".cm-lp-macro-wrap");
  await expect(preview.locator(".cm-lp-macro-wrap").first()).toHaveClass(/cm-lp-align-center/);

  await seek("[data-testid=macro-tabs]");
  const tabs = preview.locator("[data-testid=macro-tabs]");
  await expect(tabs.first()).toBeVisible();
  await expect(tabs.locator(".cm-lp-tab")).toHaveText(["One", "Two"]);

  await seek("table.cm-lp-table");
  await expect(preview.locator("table.cm-lp-table").first()).toBeVisible();

  // (c) XSS — scroll clear to the bottom so the <script> block's range is rendered, then assert nothing
  // injected or executed, and that no raw ::: marker ever appeared in any rendered viewport.
  await seek("__never-matches__"); // drains to the bottom
  await expect(preview.locator("script")).toHaveCount(0);
  await expect(preview.locator("img[onerror]")).toHaveCount(0);
  await sleep(150);
  expect(await page.evaluate(() => (window as unknown as { __xss267?: number }).__xss267)).toBeUndefined();
  for (const t of seenText) {
    expect(t).not.toContain(":::note");
    expect(t).not.toContain("::::tabs");
    expect(t).not.toContain(":::tab[");
  }

  // (d) GEOMETRY — the pane clips (overflow-hidden), the CM scroller inside owns the scrolling, and the
  // dialog stays within the viewport.
  const previewPane = page.getByTestId("template-picker-preview");
  const scroll = await previewPane.locator(".cm-scroller").evaluate((sc) => ({ sh: sc.scrollHeight, ch: sc.clientHeight }));
  expect(scroll.sh, "the tall content does not scroll inside the CM scroller").toBeGreaterThan(scroll.ch + 4);
  const dlg = (await page.getByTestId("template-picker").boundingBox())!;
  expect(dlg.y).toBeGreaterThanOrEqual(-1);
  expect(dlg.y + dlg.height).toBeLessThanOrEqual(page.viewportSize()!.height + 1);
  const pane = await previewPane.evaluate((el) => ({ cw: el.clientWidth, ch: el.clientHeight }));
  const dlgClient = await page.getByTestId("template-picker").evaluate((el) => ({ cw: el.clientWidth, ch: el.clientHeight }));
  expect(pane.cw, "preview pane is wider than the dialog (horizontal burst)").toBeLessThanOrEqual(dlgClient.cw);
  expect(pane.ch, "preview pane is taller than the dialog (vertical burst)").toBeLessThanOrEqual(dlgClient.ch);
});

// #267 (5th bounce): the REAL torture-page body expanded the two-pane row past the dialog while the
// synthetic fixture above stayed green — the row is a GRID ITEM of DialogContent whose min-width:auto
// floors it at the content's min-content (~1350px measured), pushing the preview pane out of frame where
// overflow-hidden clips it ("the preview vanished"). Fixed by min-w-0/w-full/max-w-full ON THE ROW.
// Geometry asserted with the real body at BOTH the user's viewport (1310×940) and the default-ish 1280.
for (const vp of [{ width: 1310, height: 940 }, { width: 1280, height: 720 }]) {
  test(`#267 the real torture-page preview stays inside the dialog at ${vp.width}×${vp.height}`, async ({ browser }) => {
    const page = await (await browser.newContext({ viewport: vp })).newPage();
    const src = await openScratch(page, `pick267t-${vp.width}-${Date.now()}`);
    await enterEdit(page);
    await page.click("[data-pane=preview] .cm-content");
    await page.keyboard.insertText(TORTURE);
    await sleep(600);
    await page.getByTestId("publish-page").click();
    await sleep(700);

    await page.goto(`/p/${src}`);
    await page.waitForSelector("[data-pane=preview] .cm-content");
    await page.getByTestId("page-overflow-trigger").click();
    await page.getByTestId("save-template-open").click();
    await page.getByTestId("template-name").fill(`Torture ${vp.width}`);
    await page.getByTestId("save-template-submit").click();
    await sleep(500);

    await page.getByTestId("new-page-from-template").click();
    await page.waitForSelector("[data-testid=template-picker]");
    await page.getByTestId("template-picker-item").filter({ hasText: `Torture ${vp.width}` }).first().click();
    const preview = page.getByTestId("template-picker-preview-body");
    await expect(preview.locator(".cm-content")).toContainText("拷問ページ", { timeout: 8000 }); // CM surface
    await sleep(1200); // async macro renders (mermaid/math) settle before measuring

    // BOTH panes sit inside the dialog box on the x-axis (the bounce: pane x ≈ dialog right edge).
    const dlg = (await page.getByTestId("template-picker").boundingBox())!;
    const pane = (await page.getByTestId("template-picker-preview").boundingBox())!;
    // .first: the torture body renders its own <ul>s inside the preview — the picker list is the first.
    const list = (await page.locator("[data-testid=template-picker] ul").first().boundingBox())!;
    expect(pane.x, "preview pane starts inside the dialog").toBeGreaterThanOrEqual(dlg.x - 1);
    expect(pane.x + pane.width, "preview pane ends inside the dialog").toBeLessThanOrEqual(dlg.x + dlg.width + 1);
    expect(list.x + list.width, "list pane ends inside the dialog").toBeLessThanOrEqual(dlg.x + dlg.width + 1);
    expect(pane.width, "preview pane is visibly wide (not crushed/clipped away)").toBeGreaterThan(200);
    // and the dialog itself stays within the viewport on both axes
    expect(dlg.x).toBeGreaterThanOrEqual(-1);
    expect(dlg.x + dlg.width).toBeLessThanOrEqual(vp.width + 1);
    expect(dlg.y + dlg.height).toBeLessThanOrEqual(vp.height + 1);

    // tall content scrolls INSIDE the CM scroller (the pane clips; the editor surface scrolls)
    const m = await page.getByTestId("template-picker-preview").locator(".cm-scroller").evaluate((sc) => ({ ch: sc.clientHeight, sh: sc.scrollHeight }));
    expect(m.sh, "tall torture body scrolls inside the CM scroller").toBeGreaterThan(m.ch + 4);

    // the macros still render in that constrained pane: nested tabs mount and no RAW directive
    // markers leak (the body legitimately contains a `:::` code SPAN, so check the marker forms).
    await expect(preview.locator("[data-testid=macro-tabs]").first()).toBeVisible({ timeout: 8000 });
    const text = await preview.innerText();
    expect(text).not.toContain("::::tabs");
    expect(text).not.toContain(":::tab[");
  });
}
