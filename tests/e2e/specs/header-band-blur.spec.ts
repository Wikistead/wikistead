import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #212 bounce 3 (comment 720): the header band's backdrop-blur (frosted glass) only shows if the band
// OVERLAPS scrolling content — a flow sibling ABOVE the scroller has nothing behind it to blur, so the
// effect never appeared. This asserts the STRUCTURAL preconditions the blur needs (a screenshot can't
// easily assert "frosted glass"): the band overlays the editor top, backdrop-filter is applied, the band
// lets pointer events through its transparent gradient, line 1 clears the band at scroll-top, and content
// actually scrolls BEHIND the band. The perceived frosted look itself is a review item.
test("#212: header band overlaps the scrolling editor so its backdrop-blur has content behind it", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "header-blur");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(Array.from({ length: 80 }, (_, i) => `line number ${i}`).join("\n"));
  await sleep(500);
  await page.keyboard.press("Control+Home");
  await sleep(300);

  const atTop = await page.evaluate(() => {
    const band = document.querySelector(".backdrop-blur-md") as HTMLElement;
    const scroller = document.querySelector(".lp-editor-host") as HTMLElement;
    const r = band.getBoundingClientRect(), sc = scroller.getBoundingClientRect();
    const first = (document.querySelector(".lp-editor-host .cm-line") as HTMLElement).getBoundingClientRect();
    return {
      backdrop: getComputedStyle(band).backdropFilter,
      bandPointer: getComputedStyle(band).pointerEvents,
      overlapsScroller: sc.top < r.bottom - 2, // scroller starts above the band bottom → underlaps it
      line1ClearsBand: first.top >= r.bottom - 4, // line 1 fully below the band at the top
      contentPadTop: getComputedStyle(document.querySelector(".lp-editor-host .cm-content") as HTMLElement).paddingTop,
    };
  });
  expect(atTop.backdrop, "band has a backdrop-filter blur").toContain("blur");
  expect(atTop.bandPointer, "band is pointer-transparent (clicks reach the editor through the gradient)").toBe("none");
  expect(atTop.overlapsScroller, "band must overlap the scroller (else blur has nothing behind it)").toBe(true);
  expect(atTop.line1ClearsBand, "line 1 must be visible below the band at scroll-top").toBe(true);
  expect(atTop.contentPadTop).not.toBe("0px"); // padded to clear the band

  // scroll down → content passes UNDER the band (the blur now has a live subject)
  await page.mouse.move(640, 400);
  await page.mouse.wheel(0, 220);
  await sleep(300);
  const behind = await page.evaluate(() => {
    const band = document.querySelector(".backdrop-blur-md") as HTMLElement;
    const r = band.getBoundingClientRect();
    return (Array.from(document.querySelectorAll(".lp-editor-host .cm-line")) as HTMLElement[])
      .filter((l) => { const t = l.getBoundingClientRect(); return t.bottom > r.top + 4 && t.top < r.bottom - 4; }).length;
  });
  expect(behind, "content must scroll behind the band").toBeGreaterThan(0);
});
