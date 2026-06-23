import { test, expect, type Browser } from "@playwright/test";
import { openDemo, resetDoc, paneText, charAfterCaret, enterEdit, sleep } from "../helpers";

// Single-view editor (Step I): one live-preview surface. Covers markdown decorations,
// reveal-on-cursor, cross-CLIENT sync, and the presence invariant — a remote
// collaborator's caret lands on the SAME logical char on the other client's surface,
// even though the preview hides the '**' markers (offset-invariant decorations).
test("decorations, sync, and cross-client presence", async ({ browser }: { browser: Browser }) => {
  const A = await (await browser.newContext()).newPage();
  const B = await (await browser.newContext()).newPage();
  await openDemo(A);
  await openDemo(B);
  await enterEdit(A);
  await enterEdit(B);
  await resetDoc(A);

  // (1) real editor + markdown decorations (cursor parked off the construct lines)
  await A.click("[data-pane=preview] .cm-content");
  for (const line of ["# Heading", "a **bold** b", "`code`", "[text](url)", "- item", "> quote", ""]) {
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
      quote: !!q("[data-pane=preview] .cm-lp-quote"), // blockquote renderer (Step I bug #2)
      boldLine: line("bold")?.innerText.replace(/[​⁠]/g, ""),
    };
  });
  expect(deco.h1).toBe(true);
  expect(deco.strong).toBe("bold");
  expect(deco.boldLine).toBe("a bold b"); // '**' hidden
  expect(deco.code).toBe("code");
  expect(deco.bullet).toBe(true);
  expect(deco.link).toContain("text");
  expect(deco.quote).toBe(true);

  // (2) cross-client sync: B's surface renders A's content (the bold word). Checked
  // BEFORE the reveal click below — once A's caret moves onto the bold line, yCollab
  // draws A's remote caret label inline on B, splitting the "bold" text node.
  await B.waitForFunction(() => (document.querySelector("[data-pane=preview] .cm-content")?.textContent ?? "").includes("bold"), undefined, { timeout: 5000 });
  expect(await paneText(B, "preview")).toContain("bold");

  // (3) reveal-on-cursor: clicking the bold construct reveals its raw '**'
  await A.locator("[data-pane=preview] .cm-lp-strong").first().click();
  await sleep(200);
  const revealed = await A.evaluate(() => [...document.querySelectorAll("[data-pane=preview] .cm-line")].find((l) => (l as HTMLElement).innerText.includes("bold"))?.textContent ?? "");
  expect(revealed).toContain("**");

  // (4) cross-client presence: one line, A's caret at offset 5 ('o' of "bold").
  await resetDoc(A);
  await A.keyboard.type("a **bold** b");
  await A.keyboard.press("Enter");
  await A.keyboard.type("second line");
  await sleep(250);
  await B.waitForFunction(() => (document.querySelector("[data-pane=preview] .cm-content")?.textContent ?? "").includes("second"), undefined, { timeout: 5000 });

  // B parks on line 2 → B's line-1 RENDERS (its '**' hidden), so the remote caret
  // must map through the hidden markers to still land on the same logical char.
  await B.evaluate(() => {
    const l = [...document.querySelectorAll("[data-pane=preview] .cm-line")].find((x) => (x as HTMLElement).innerText.includes("second")) as HTMLElement;
    const r = l.getBoundingClientRect();
    (document.elementFromPoint(r.x + 6, r.y + r.height / 2) as HTMLElement)?.click();
  });

  // A places a collapsed caret at doc offset 5 ('o'). A real-clicks line 1 (a genuine
  // pointer event, so CM moves the cursor → the line REVEALS its raw markdown and the
  // hidden markers stop being atomic), then Home + 5×ArrowRight steps 1:1 to offset 5.
  await A.locator("[data-pane=preview] .cm-line").filter({ hasText: "bold" }).first().click();
  await sleep(150);
  await A.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await A.keyboard.press("ArrowRight");
  await A.bringToFront();
  await sleep(450);

  await B.waitForFunction(
    () => !!document.querySelector("[data-pane=preview] .cm-ySelectionCaret"),
    undefined,
    { timeout: 6000 },
  );
  // KEY: the same logical char on B despite B's preview hiding line-1 '**'. Poll to
  // absorb cross-client awareness latency.
  await expect.poll(async () => (await B.evaluate(charAfterCaret(), "[data-pane=preview]")).char, { timeout: 6000 }).toBe("o");
});
