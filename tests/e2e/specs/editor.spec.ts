import { test, expect, type Browser } from "@playwright/test";
import { openDemo, resetDoc, paneText, charAfterCaret, enterSplit, sleep } from "../helpers";

// Core two-surface editor + the locked invariant: a collaborator's caret lands on
// the SAME logical char in the raw source pane and the decorated preview pane.
test("decorations, sync, and cross-surface presence", async ({ browser }: { browser: Browser }) => {
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  await openDemo(A);
  await openDemo(B);
  // P3: the editor defaults to read-only view; this test drives both surfaces, so
  // open the editable source+preview split on each.
  await enterSplit(A);
  await enterSplit(B);
  await resetDoc(A);

  // (1) real editor + markdown decorations (cursor parked off the construct lines)
  await A.click("[data-pane=preview] .cm-content");
  for (const line of ["# Heading", "a **bold** b", "`code`", "[text](url)", "- item", ""]) {
    await A.keyboard.type(line);
    await A.keyboard.press("Enter");
  }
  await sleep(300);
  const deco = await A.evaluate(() => {
    const q = (s: string) => document.querySelector(s);
    const line = (t: string) => [...document.querySelectorAll("[data-pane=preview] .cm-line")].find((l) => (l as HTMLElement).innerText.includes(t)) as HTMLElement | undefined;
    return {
      h1: !!q("[data-pane=preview] .cm-lp-h1"),
      strong: q("[data-pane=preview] .cm-lp-strong")?.textContent,
      code: q("[data-pane=preview] .cm-lp-inline-code")?.textContent,
      bullet: !!q("[data-pane=preview] .cm-lp-bullet"),
      link: q("[data-pane=preview] .cm-lp-link")?.textContent,
      boldLine: line("bold")?.innerText.replace(/[​⁠]/g, ""),
    };
  });
  expect(deco.h1).toBe(true);
  expect(deco.strong).toBe("bold");
  expect(deco.boldLine).toBe("a bold b"); // '**' hidden
  expect(deco.code).toBe("code");
  expect(deco.bullet).toBe(true);
  expect(deco.link).toContain("text");

  // (2) reveal-on-cursor
  await A.locator("[data-pane=preview] .cm-lp-strong").first().click();
  await sleep(200);
  const revealed = await A.evaluate(() => [...document.querySelectorAll("[data-pane=preview] .cm-line")].find((l) => (l as HTMLElement).innerText.includes("bold"))?.textContent ?? "");
  expect(revealed).toContain("**");

  // (3) cross-client sync
  await B.waitForFunction(() => document.querySelector("[data-pane=source] .cm-content")!.textContent!.includes("Heading"), undefined, { timeout: 5000 });
  expect(await paneText(B, "source")).toContain("**bold**");

  // (4) cross-surface presence: reset to one line, A caret at offset 5 ('o')
  await resetDoc(A);
  await A.keyboard.type("a **bold** b");
  await A.keyboard.press("Enter");
  await A.keyboard.type("second line");
  await sleep(250);
  await B.waitForFunction(() => document.querySelector("[data-pane=source] .cm-content")!.textContent!.includes("**bold**"), undefined, { timeout: 5000 });

  // B parks on line 2 so B's preview HIDES line-1 '**'
  await B.evaluate(() => {
    const l = [...document.querySelectorAll("[data-pane=preview] .cm-line")].find((x) => (x as HTMLElement).innerText.includes("second")) as HTMLElement;
    const r = l.getBoundingClientRect();
    (document.elementFromPoint(r.x + 6, r.y + r.height / 2) as HTMLElement)?.click();
  });
  // A places a collapsed caret at offset 5 in the source (vim) pane
  await A.click("[data-pane=source] .cm-content");
  await A.keyboard.press("Escape");
  await A.keyboard.type("gg0");
  await A.keyboard.type("i");
  for (let i = 0; i < 5; i++) await A.keyboard.press("ArrowRight");
  await A.bringToFront();
  await sleep(450);

  await B.waitForFunction(
    () => document.querySelector("[data-pane=source] .cm-ySelectionCaret") && document.querySelector("[data-pane=preview] .cm-ySelectionCaret"),
    undefined,
    { timeout: 6000 },
  );
  const src = await B.evaluate(charAfterCaret(), "[data-pane=source]");
  const pv = await B.evaluate(charAfterCaret(), "[data-pane=preview]");
  // KEY: same logical char in both surfaces despite the preview hiding '**'.
  expect(src.char).toBe("o");
  expect(pv.char).toBe("o");
});
