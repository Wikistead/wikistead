import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, setPublicSurface, sleep } from "../helpers";

// #518: an explicit table header (GFM top row = thead th; a :::table row header = a th that is the first
// cell of its row) stays pinned while a TALL table scrolls. The scroll wrapper gets a max-height so the
// table scrolls inside its box with the header sticky (page-basis top sticky is impossible while the
// overflow-x wrap is the vertical scroll ancestor). Pinned on the CM read surface (/pub) on a real browser.
const API = "http://dev.localhost:4010";

test("#518: a tall table's header row is sticky and stays put while the table box scrolls", async ({ browser }) => {
  const authed = await (await browser.newContext()).newPage();
  const id = await openScratch(authed, `sticky518-${Date.now().toString(36)}`);
  await enterEdit(authed);
  await authed.click("[data-pane=preview] .cm-content");
  let md = "# Sticky\n\n| Head A | Head B |\n|---|---|\n";
  for (let i = 0; i < 40; i++) md += `| r${i}a | r${i}b |\n`;
  await authed.keyboard.insertText(md + "\ntail\n");
  await authed.getByText("tail", { exact: true }).click();
  await sleep(500);
  await authed.getByTestId("publish-page").click();
  await sleep(1000);
  await fetch(`${API}/pages/${id}/public`, { method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ public: true }) });
  await setPublicSurface(authed, true);

  const anon = await (await browser.newContext({ viewport: { width: 900, height: 500 } })).newPage();
  await anon.goto(`/pub/${id}`);
  await anon.waitForSelector(".cm-lp-table thead th", { timeout: 10000 });

  const rep = await anon.evaluate(() => {
    const th = document.querySelector(".cm-lp-table thead th") as HTMLElement;
    const scroll = document.querySelector(".cm-lp-table-scroll") as HTMLElement;
    const pos = getComputedStyle(th).position;
    const t0 = th.getBoundingClientRect().top;
    scroll.scrollTop = 250; // scroll the tall table down inside its box
    const t1 = th.getBoundingClientRect().top;
    const boxScrolls = scroll.scrollHeight > scroll.clientHeight + 2;
    return { pos, t0, t1, boxScrolls };
  });
  expect(rep.pos, "the header row is sticky").toBe("sticky");
  expect(rep.boxScrolls, "a 40-row table overflows its max-height box").toBe(true);
  // the header barely moved (stuck) — without sticky it would have risen by ~250px
  expect(Math.abs(rep.t1 - rep.t0), "the header stays put while the body scrolls under it").toBeLessThan(4);
});
