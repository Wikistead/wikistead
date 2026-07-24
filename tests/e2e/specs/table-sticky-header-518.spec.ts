import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, setPublicSurface, sleep } from "../helpers";

// #518 (re-design): the table header follows the PAGE scroll — NOT a box-scroll. The user wants ALL
// rows shown, the header pinned just below the app band as the page scrolls, and (thehard bug) a wide
// table's columns must stay reachable (the earlier overflow-x box clipped them / broke editing). So there is
// NO local scroll box: the table overflows onto `.cm-scroller`, which scrolls sideways (columns reachable),
// and `thead th`'s sticky top resolves against `.cm-scroller` (page-basis header-follow). Pinned on the real
// CM read surface (/pub) measuring the th itself and the .cm-scroller, in a real browser.
const API = "http://dev.localhost:4010";

// A tall (45-row) + wide (12-col) :::table.
function bigTableMd(): string {
  const head = Array.from({ length: 12 }, (_, c) => `<th>H${c}</th>`).join("");
  let rows = "";
  for (let r = 0; r < 44; r++) rows += "<tr>" + Array.from({ length: 12 }, (_, c) => `<td>r${r}c${c}</td>`).join("") + "</tr>";
  return `# Sticky\n\n:::table\n<table><tr>${head}</tr>${rows}</table>\n:::\n\ntail\n`;
}

test("#518a :::table header FOLLOWS the page scroll (not a box), all rows shown, columns reachable", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, `sticky518-${Date.now().toString(36)}`);
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  await authed.keyboard.insertText(bigTableMd());
  await authed.getByText("tail", { exact: true }).click();
  await sleep(500);
  await authed.getByTestId("publish-page").click();
  await sleep(1000);
  await fetch(`${API}/pages/${id}/public`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ public: true }) });
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext({ viewport: { width: 900, height: 520 } })).newPage();
  await anon.goto(`/pub/${id}`);
  await anon.waitForSelector(".cm-lp-table-merged thead th", { timeout: 10000 });

  const rep = await anon.evaluate(() => {
    const table = document.querySelector(".cm-lp-table-merged") as HTMLElement;
    const th = table.querySelector("thead th") as HTMLElement;
    const box = th.closest(".cm-lp-table-scroll") as HTMLElement;
    const scroller = document.querySelector(".cm-scroller") as HTMLElement;
    const cs = getComputedStyle(th);
    // 1. NOT a local scroll box: the wrapper is a passthrough (overflow visible), so a tall table shows every
    //    row inside it rather than clipping to a max-height (the whole table's height lives in the box).
    const boxIsScrollBox = box.scrollHeight > box.clientHeight + 2;
    const boxOverflow = getComputedStyle(box).overflowY;
    // 2. a wide table overflows onto the editor scroller (columns reachable via horizontal page scroll)
    const scrollerScrollsX = scroller.scrollWidth > scroller.clientWidth + 2;
    // 3. page-basis header-follow: scroll the EDITOR (.cm-scroller) to TWO positions both past the table's
    //    start. If the header is page-pinned it stays at the SAME viewport top at both (near the band); in the
    //    old box-scroll model the th tracked the box (which scrolls with .cm-scroller) so it would move ~300px.
    return new Promise<{ position: string; top: string; boxIsScrollBox: boolean; boxOverflow: string; scrollerScrollsX: boolean; top1: number; top2: number }>((resolve) => {
      scroller.scrollTop = 300;
      requestAnimationFrame(() => {
        const top1 = th.getBoundingClientRect().top;
        scroller.scrollTop = 600;
        requestAnimationFrame(() => {
          const top2 = th.getBoundingClientRect().top;
          resolve({ position: cs.position, top: cs.top, boxIsScrollBox, boxOverflow, scrollerScrollsX, top1, top2 });
        });
      });
    });
  });

  expect(rep.position, "header th is sticky").toBe("sticky");
  expect(rep.top, "sticky top resolves to a real offset (band var), NOT auto").not.toBe("auto");
  expect(rep.boxOverflow, "the wrapper is a passthrough (no local scroll box)").toBe("visible");
  expect(rep.boxIsScrollBox, "the table is NOT clipped into a max-height box — all rows are shown").toBe(false);
  expect(rep.scrollerScrollsX, "a wide table overflows onto .cm-scroller so every column is reachable").toBe(true);
  // page-follow: at two different page-scroll positions the header stays at the SAME viewport top (pinned near
  // the band), and that top is near the viewport top (not scrolled off). Box-scroll would move it ~300px.
  expect(rep.top1, "the pinned header sits near the viewport top (below the band), not scrolled away").toBeGreaterThan(-4);
  expect(rep.top1, "the pinned header sits near the viewport top, not below the fold").toBeLessThan(160);
  expect(Math.abs(rep.top2 - rep.top1), "the header stays put as the page scrolls further under it (page-pinned)").toBeLessThan(8);
});
