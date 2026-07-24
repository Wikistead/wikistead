import { test, expect, type Browser } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

// #456 review rejection (2026-07-24): the code-settings panel printed light-grey in a DARK theme. Measured
// cause: CM injects `.cm-tooltip{background:#f5f5f5}` at editor mount — same specificity as the panel's own
// rules but LATER in source order — so it won the cascade even though --panel resolved dark at the node.
// Pin (real computed style) that the panel surface FOLLOWS the theme: dark in dark, light in light.
async function panelBg(browser: Browser, theme: "dark" | "light"): Promise<[number, number, number]> {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript((t) => localStorage.setItem("wks.theme", t), theme);
  await openScratch(p, `fence456dl-${theme}-${Date.now()}`);
  await enterEdit(p);
  await p.click("[data-pane=preview] .cm-content");
  await p.keyboard.insertText("```ts\nconst a = 1\n```\n\nbelow\n");
  await sleep(600);
  await p.getByText("const a = 1", { exact: true }).click({ button: "right" });
  await expect(p.getByTestId("ctx-item-codesettings")).toBeVisible({ timeout: 8000 });
  await p.getByTestId("ctx-item-codesettings").click();
  await expect(p.getByTestId("fence-settings-panel")).toBeVisible({ timeout: 8000 });
  const rgb = await p.evaluate(() => {
    const cs = getComputedStyle(document.querySelector(".cm-lp-fence-settings")!);
    const m = cs.backgroundColor.match(/\d+/g)!.map(Number);
    return [m[0], m[1], m[2]] as [number, number, number];
  });
  await ctx.close();
  return rgb;
}

test("#456: the code-settings panel surface follows the theme (dark stays dark)", async ({ browser }) => {
  const dark = await panelBg(browser, "dark");
  // dark theme → a dark surface (var(--panel) #252526), NOT CM's light default #f5f5f5 (245,245,245).
  expect(dark[0]).toBeLessThan(80);
  expect(dark.join(",")).not.toBe("245,245,245");
});

test("#456: light-theme panel stays light (non-regression)", async ({ browser }) => {
  const light = await panelBg(browser, "light");
  expect(light[0]).toBeGreaterThan(200); // var(--panel) light (#f6f8fa)
});
