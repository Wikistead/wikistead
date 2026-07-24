import { test, expect } from "@playwright/test";
import { openDemo, sleep } from "../helpers";

// #530: native `title` tooltips wait ~1–2s (browser-controlled), cannot be themed, and never appear on
// keyboard focus. Slice 1 replaces the mechanism: a Radix <Tooltip> for React and a delegated `data-tip`
// controller for DOM built outside React (CodeMirror widgets, macro chrome), sharing ONE delay and ONE
// look. Pinned on the sidebar page name — the tooltip the user named as too slow.

test("#530: a truncated sidebar page name shows the fast tooltip (not a native title)", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page-name]", { timeout: 15000 });

  // find a row whose name is actually truncated (that is when the tooltip is offered at all)
  const idx = await page.evaluate(() => {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-testid=tree-page-name]")];
    return rows.findIndex((el) => el.scrollWidth > el.clientWidth);
  });
  test.skip(idx < 0, "no truncated page name in this fixture");
  const row = page.locator("[data-testid=tree-page-name]").nth(idx);

  await row.hover();
  // the mechanism swapped: a `data-tip` attribute, never a native `title`
  await expect.poll(async () => row.getAttribute("data-tip"), { timeout: 2000 }).toBeTruthy();
  expect(await row.getAttribute("title"), "no native title is left behind").toBeNull();

  // the bubble appears well inside the native delay (native is ~1000ms+; ours is 180ms)
  const shown = await page.evaluate(async () => {
    const el = [...document.querySelectorAll<HTMLElement>("[data-testid=tree-page-name]")].find((e) => e.dataset.tip);
    if (!el) return { appeared: false, ms: -1 };
    const t0 = performance.now();
    el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    for (let i = 0; i < 60; i++) {
      const tip = document.querySelector(".wks-tip") as HTMLElement | null;
      if (tip && !tip.hidden) return { appeared: true, ms: Math.round(performance.now() - t0), text: tip.textContent ?? "" };
      await new Promise((r) => setTimeout(r, 20));
    }
    return { appeared: false, ms: -1 };
  });
  expect(shown.appeared, "the delegated tooltip bubble appears").toBe(true);
  expect(shown.ms, "and it appears fast (well under the ~1s native delay)").toBeLessThan(600);
});

test("#530: the delegated tooltip also appears on KEYBOARD focus (native title never does)", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]", { timeout: 15000 });

  const rep = await page.evaluate(async () => {
    // a focusable element carrying data-tip: build one, since focus parity is a property of the host.
    // The button must be IN the layout (a zero-box element still focuses, but the placement read is
    // meaningless), and the host reuses ONE bubble node — so wait for its text to become ours.
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.tip = "focus tooltip probe";
    btn.textContent = "probe";
    btn.setAttribute("aria-label", "probe button");
    btn.style.cssText = "position:fixed;left:40px;top:200px;z-index:1";
    document.body.appendChild(btn);
    btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    btn.focus();
    let shown = false;
    for (let i = 0; i < 80; i++) {
      const tip = document.querySelector(".wks-tip") as HTMLElement | null;
      if (tip && !tip.hidden && (tip.textContent ?? "").includes("focus tooltip probe")) { shown = true; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    const keptLabel = btn.getAttribute("aria-label");
    btn.remove();
    return { shown, keptLabel };
  });
  expect(rep.shown, "focus shows the tooltip").toBe(true);
  expect(rep.keptLabel, "the accessible name (aria-label) is untouched — the tooltip only describes").toBe("probe button");
});

test("#530: the tooltip surface follows the theme (readable in dark)", async ({ page }) => {
  await openDemo(page);
  await page.waitForSelector("[data-testid=tree-page]", { timeout: 15000 });
  const rep = await page.evaluate(async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const btn = document.createElement("button");
    btn.dataset.tip = "dark probe";
    btn.style.cssText = "position:fixed;left:40px;top:200px;z-index:1";
    document.body.appendChild(btn);
    btn.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    let tip: HTMLElement | null = null;
    for (let i = 0; i < 80; i++) {
      const t = document.querySelector(".wks-tip") as HTMLElement | null;
      if (t && !t.hidden && (t.textContent ?? "").includes("dark probe")) { tip = t; break; }
      await new Promise((r) => setTimeout(r, 20));
    }
    const cs = tip ? getComputedStyle(tip) : null;
    const out = { shown: !!tip, bg: cs?.backgroundColor ?? "", fg: cs?.color ?? "", pos: cs?.position ?? "" };
    btn.remove();
    return out;
  });
  expect(rep.shown, "the bubble showed for the probe").toBe(true);
  // the bubble paints a real (non-transparent) themed surface and is viewport-positioned
  expect(rep.bg).not.toBe("rgba(0, 0, 0, 0)");
  expect(rep.bg).not.toBe("");
  expect(rep.pos, "fixed positioning keeps it out of any widget's overflow").toBe("fixed");
});
