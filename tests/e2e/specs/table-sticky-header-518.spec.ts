import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, setPublicSurface, sleep } from "../helpers";

// #518: an explicit table header (top row = thead th; a row header = the first-column th) stays pinned
// while a TALL table scrolls, and a WIDE table gets its OWN horizontal scrollbar (the editor must NOT
// scroll sideways). Thedevice trace found theattempt was false-green: it exercised a GFM
// pipe table (which DID get a `.cm-lp-table-scroll` box + a <thead>), while the actual regression was on
// a :::table macro — a MacroWidget whose table had NO scroll box and NO <thead>, so its th had
// `position: sticky` but `top: auto` (inert), and its overflow scrolled `.cm-scroller` (the whole editor).
// This spec pins the :::table path on the real CM read surface (/pub) measuring the th itself, not
// `.cm-scroller`.
const API = "http://dev.localhost:4010";

// A tall (45-row) + wide (12-col) :::table: 12 columns overflow a 900px viewport (horizontal box scroll),
// 45 rows overflow the max-height box (vertical box scroll → sticky thead has something to pin against).
function bigTableMd(): string {
  const head = Array.from({ length: 12 }, (_, c) => `<th>H${c}</th>`).join("");
  let rows = "";
  for (let r = 0; r < 44; r++) rows += "<tr>" + Array.from({ length: 12 }, (_, c) => `<td>r${r}c${c}</td>`).join("") + "</tr>";
  return `# Sticky\n\n:::table\n<table><tr>${head}</tr>${rows}</table>\n:::\n\ntail\n`;
}

test("#518: a tall+wide :::table pins its header (top not auto) and scrolls INSIDE its own box", async ({ browser }) => {
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
  // the :::table renders as .cm-lp-table.cm-lp-table-merged with a <thead> (gridToTable) inside a
  // .cm-lp-table-scroll box (liveRender wrap) — wait for the header cell specifically.
  await anon.waitForSelector(".cm-lp-table-merged thead th", { timeout: 10000 });

  const rep = await anon.evaluate(() => {
    const table = document.querySelector(".cm-lp-table-merged") as HTMLElement;
    const th = table.querySelector("thead th") as HTMLElement;
    const th0 = table.querySelector("thead th:first-child") as HTMLElement;
    const box = th.closest(".cm-lp-table-scroll") as HTMLElement;
    const scroller = document.querySelector(".cm-scroller") as HTMLElement;
    const cs = getComputedStyle(th);
    // 1. the box is a real LOCAL scroll container (both axes overflow inside it, not the editor)
    const boxScrollsY = box.scrollHeight > box.clientHeight + 2;
    const boxScrollsX = box.scrollWidth > box.clientWidth + 2;
    const scrollerScrollsX = scroller.scrollWidth > scroller.clientWidth + 2; // must stay false: editor must NOT shift
    // 2. vertical: header stays pinned when the BOX scrolls down
    const topBefore = th.getBoundingClientRect().top;
    box.scrollTop = 260;
    const topAfter = th.getBoundingClientRect().top;
    // 3. horizontal: left-column header stays pinned when the BOX scrolls right
    box.scrollTop = 0;
    const leftBefore = th0.getBoundingClientRect().left;
    box.scrollLeft = 300;
    const leftAfter = th0.getBoundingClientRect().left;
    return {
      position: cs.position, top: cs.top,
      boxScrollsY, boxScrollsX, scrollerScrollsX,
      vMove: Math.abs(topAfter - topBefore), hMove: Math.abs(leftAfter - leftBefore),
    };
  });

  // the real failure signature the device trace caught: sticky but top:auto (inert)
  expect(rep.position, "header th is sticky").toBe("sticky");
  expect(rep.top, "sticky top is a real offset, NOT auto (thebug)").not.toBe("auto");
  // the table scrolls inside its own box on BOTH axes, and the editor does NOT scroll sideways
  expect(rep.boxScrollsY, "a 45-row :::table overflows its max-height box vertically").toBe(true);
  expect(rep.boxScrollsX, "a 12-col :::table overflows its box horizontally (its own scrollbar)").toBe(true);
  expect(rep.scrollerScrollsX, "the editor .cm-scroller does NOT scroll sideways (table box absorbs it)").toBe(false);
  // header stays put on vertical scroll, left column stays put on horizontal scroll
  expect(rep.vMove, "the header row stays pinned while the body scrolls under it").toBeLessThan(4);
  expect(rep.hMove, "the left-column header stays pinned while columns scroll under it").toBeLessThan(4);
});
