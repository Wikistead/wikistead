import { test, expect, type Browser } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #456 review rejections (2026-07-24, twice). The code-settings panel must follow the theme on EVERY face.
// Round 1 fixed only the body and the pin only measured the body — so the frame and the arrow stayed light
// and it came back. Measured causes:
//   - CM's `&light .cm-tooltip { background:#f5f5f5; border:1px solid #bbb }` outranks a single-class rule.
//   - The panel div IS the tooltip (class="cm-lp-fence-settings cm-tooltip …") and the arrow is its CHILD,
//     so the old `.cm-tooltip:has(.cm-lp-fence-settings)` rules could never match.
// This pins all THREE faces (body, frame, arrow) in dark, and light as a non-regression.
interface Faces {
  bg: [number, number, number];
  border: [number, number, number];
  arrowFill: [number, number, number];
  arrowLine: [number, number, number];
}

async function panelFaces(browser: Browser, theme: "dark" | "light"): Promise<Faces> {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript((t) => localStorage.setItem("wks.theme", t), theme);
  await openScratch(p, `fence456f-${theme}-${Date.now()}`);
  await enterEdit(p);
  await p.click("[data-pane=preview] .cm-content");
  await p.keyboard.insertText("```ts\nconst a = 1\n```\n\nbelow\n");
  await sleep(600);
  await p.getByText("const a = 1", { exact: true }).click({ button: "right" });
  await expect(p.getByTestId("ctx-item-codesettings")).toBeVisible({ timeout: 8000 });
  await p.getByTestId("ctx-item-codesettings").click();
  await expect(p.getByTestId("fence-settings-panel")).toBeVisible({ timeout: 8000 });
  const faces = await p.evaluate(() => {
    const rgb = (s: string): [number, number, number] => {
      const m = s.match(/\d+/g)!.map(Number);
      return [m[0]!, m[1]!, m[2]!];
    };
    const panel = document.querySelector<HTMLElement>(".cm-lp-fence-settings")!;
    const cs = getComputedStyle(panel);
    const arrow = document.querySelector<HTMLElement>(".cm-lp-fence-settings > .cm-tooltip-arrow")!;
    return {
      bg: rgb(cs.backgroundColor),
      border: rgb(cs.borderTopColor),
      arrowFill: rgb(getComputedStyle(arrow, "::after").borderBottomColor),
      arrowLine: rgb(getComputedStyle(arrow, "::before").borderBottomColor),
    };
  });
  await ctx.close();
  return faces;
}

test("#456: EVERY face of the code-settings panel follows a dark theme (body, frame, arrow)", async ({ browser }) => {
  const f = await panelFaces(browser, "dark");
  // dark tokens: --panel #252526 (37,37,38), --border #3a3a3a (58,58,58).
  // Pre-fix measurements were body #f5f5f5, frame #bbb (187), arrow fill #f5f5f5 (245) — all light.
  expect(f.bg[0], "panel body").toBeLessThan(80);
  expect(f.border[0], "panel frame (was #bbb)").toBeLessThan(80);
  expect(f.arrowFill[0], "arrow fill (was #f5f5f5)").toBeLessThan(80);
  expect(f.arrowLine[0], "arrow outline (was #bbb)").toBeLessThan(80);
});

test("#456: light theme keeps a light panel on every face (non-regression)", async ({ browser }) => {
  const f = await panelFaces(browser, "light");
  expect(f.bg[0], "panel body").toBeGreaterThan(200); // --panel #f6f8fa
  expect(f.arrowFill[0], "arrow fill").toBeGreaterThan(200);
  expect(f.border[0], "panel frame (--border #d0d7de)").toBeGreaterThan(150);
});
