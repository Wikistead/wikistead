import { test, expect, type Browser } from "@playwright/test";
import { openScratch, sleep } from "../helpers";

// #505 (user ruling 2026-07-27): print is LIGHT-FIXED — the earlier "real dark print" is retracted, and
// ADR-191 folds print onto the same answer the export stylesheet already gives. The trap this pins: simply
// dropping the dark sheet is NOT enough. In a dark theme the reading text is a light grey, so a white sheet
// plus the dark theme's --fg is the faint, unreadable print this ticket opened with — and a `:root` override
// does not even win, because tokens.css sets the dark values on `:root[data-theme="dark"]` (measured).
// So: whatever the app theme, the printed surface must be a white sheet with dark text.
async function printedColours(browser: Browser, theme: "dark" | "light") {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript((t) => localStorage.setItem("wks.theme", t), theme);
  await openScratch(p, `print505-${theme}-${Date.now()}`);
  await sleep(400);
  await p.emulateMedia({ media: "print" });
  const out = await p.evaluate(() => {
    const rgb = (s: string) => (s.match(/\d+/g) ?? ["0"]).map(Number);
    const root = document.querySelector("[data-print-root]") as HTMLElement | null;
    const cs = root ? getComputedStyle(root) : getComputedStyle(document.body);
    return { bg: rgb(cs.backgroundColor), fg: rgb(cs.color), hasRoot: !!root };
  });
  await ctx.close();
  return out;
}

for (const theme of ["dark", "light"] as const) {
  test(`#505: the ${theme}-theme print surface is a white sheet with dark text`, async ({ browser }) => {
    const c = await printedColours(browser, theme);
    expect(c.bg[0], "white sheet").toBeGreaterThan(240);
    expect(c.fg[0], "dark text — a light --fg here is the faint print the ticket opened with").toBeLessThan(90);
  });
}
