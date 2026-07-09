import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #243 / ADR-111 C1: mermaid + plantuml (text fence macros with the inline editUI) join the CALLOUT
// reveal class. A caret INSIDE reveals the raw source (editable — vim / slash-completion) instead of the
// rendered atom, plus the shared RichUI-entry pill (✎ / Ctrl+↵ → the editUI). This is the same reveal
// mechanism a callout uses (verified: vim j onto a callout reveals its raw source, not a single-stop atom).
// Excalidraw (a MODAL editUI) is excluded — it stays a single-stop atom (covered in atom-motion.spec).
const headLine = (page: any) => page.evaluate(() => (window as any).__lpHeadLine);

test("#243: a caret INSIDE a rendered mermaid reveals its raw source + the RichUI-entry pill", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "reveal-mermaid");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n```\nbelow\n");
  await sleep(700);
  // rendered as an atom while the caret is OUTSIDE
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
  // click the diagram → the caret lands inside → the raw source reveals (callout-identical)
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0); // no longer rendered
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```mermaid"); // raw shown
  await expect(page.locator("[data-pane=preview] [data-testid=fence-richui-enter]")).toBeVisible(); // the pill
});

test("#243: moving the caret OUT re-renders the diagram (enter-to-edit, like a callout)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "reveal-leave");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n```\nbelow\n");
  await sleep(700);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click(); // reveal
  await sleep(250);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0);
  // click the "below" line → caret leaves the fence range → the diagram re-renders
  await page.getByText("below", { exact: true }).click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
});

test("#243: the RichUI-entry pill opens the editUI (rich edit), not raw", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "reveal-pill");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n```\nbelow\n");
  await sleep(700);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click(); // reveal → pill
  await sleep(250);
  await page.locator("[data-pane=preview] [data-testid=fence-richui-enter]").click({ force: true });
  await sleep(400);
  await expect(page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]")).toBeVisible(); // the editUI
});

// #243 arbitration (a): after the editUI exits (Escape / Done), the caret is placed on the line
// AFTER the block, so the caret-in reveal does NOT re-fire — the rendered diagram is shown, not the raw
// source. (The #239 editui-exit spec asserts the render; here we assert the caret is OUTSIDE the fence.)
test("#243: exiting the editUI drops the caret BELOW the block so the diagram shows (not raw)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "reveal-exit");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```mermaid\nflowchart TD\n  A --> B\n```\n\nbelow\n");
  await sleep(700);
  // open the editUI via the ✎ on the rendered atom
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").hover();
  await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]")).toBeVisible();
  // exit via Done
  await page.locator("[data-pane=preview] [data-testid=editui-done]").click({ force: true });
  await sleep(500);
  // the diagram re-rendered (NOT the raw source) — caret-in reveal did not re-fire on exit
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
  expect(await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").count()).toBe(0);
  // the caret is on line 5 (the blank line after the ```mermaid…``` block that ends at line 4), NOT inside
  expect(await headLine(page)).toBeGreaterThanOrEqual(5);
});

// #243 (motion anti-regression): once a TALL mermaid is revealed (raw source), the fence lines are
// ordinary editable text — vim j must advance EXACTLY one doc line per key (no warp / overshoot across the
// former widget's rendered height). Reveal via a click, then step down through the raw source.
test("#243: motion inside a revealed TALL mermaid is one doc line per key (no warp)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "reveal-motion");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n  B --> C\n  C --> D\n```\nbelow\n");
  await sleep(2000); // the SVG mounts → the widget is tall while rendered
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click(); // reveal the raw source
  await sleep(300);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0);
  await page.getByTestId("vim-toggle").click();
  await page.click("[data-pane=preview] .cm-content");
  // land the caret on the opening fence line (line 2) and step down through the revealed source
  await page.keyboard.press("Escape");
  await page.keyboard.press("g"); await page.keyboard.press("g"); await sleep(120); // line 1 (top)
  await page.keyboard.press("j"); await sleep(120); // line 2 (```mermaid) — revealed, editable
  let prev = await headLine(page);
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("j");
    await sleep(90);
    const cur = await headLine(page);
    expect(cur, `step ${i}: ${prev}→${cur}`).toBe(prev + 1); // exactly one doc line, no warp across the tall region
    prev = cur;
  }
});

// #243 / ADR-111 C3 slice 2: the CM6 editUI source pane follows the OUTER editor's vim setting (the same
// @replit/codemirror-vim, per-view state — not a second engine). With vim ON, the pane opens in NORMAL mode,
// so a bare letter is a vim COMMAND, not inserted text. We prove it with `x` (delete char under the caret):
// a vim pane consumes it (no "x" appears); a plain pane would insert the literal "x".
test("#243 C3: the mermaid editUI CM6 source pane follows the outer vim setting", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-vim");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click(); // outer editor vim ON
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.insertText("```mermaid\nflowchart TD\n```\n\nbelow\n");
  await sleep(600);
  await page.getByText("below", { exact: true }).click(); // caret out → the atom renders
  await sleep(200);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").hover();
  await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true }); // ✎ → editUI
  const src = page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]");
  await expect(src).toBeVisible();
  await sleep(300); // let the CM6 focus + vim (normal mode) settle
  const before = await src.textContent();
  expect(before).toContain("flowchart TD"); // seeded
  // NORMAL-mode `x` is a delete-char command in vim — a plain (non-vim) editor would insert a literal "x".
  await page.keyboard.press("x");
  await sleep(200);
  const after = await src.textContent();
  expect(after, `vim x should be a command, not inserted text (was: ${before}, now: ${after})`).not.toContain("x");
});

// #243 / ADR-111 C3 slice 2b: in the vim editUI, the FIRST Escape does vim insert→normal (the panel STAYS),
// and only a NORMAL-mode Escape exits — the host's Escape handler defers via the controller's handlesEscape().
test("#243 C3: in the vim editUI the first Escape does insert→normal (stays), the second exits", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-vim-esc");
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click(); // outer editor vim ON
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.insertText("```mermaid\nflowchart TD\n```\n\nbelow\n");
  await sleep(600);
  await page.getByText("below", { exact: true }).click();
  await sleep(200);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").hover();
  await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true }); // ✎ → editUI
  const src = page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]");
  await expect(src).toBeVisible();
  await sleep(300);
  await page.keyboard.press("i"); // NORMAL → INSERT
  await page.keyboard.type("XYZ");
  await sleep(150);
  // FIRST Escape: vim insert→normal — the panel STAYS (does NOT exit to the rendered diagram)
  await page.keyboard.press("Escape");
  await sleep(250);
  await expect(src).toBeVisible(); // still editing in the panel
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0); // NOT exited
  // SECOND Escape: vim is NORMAL now → the host exits the editUI, the diagram renders
  await page.keyboard.press("Escape");
  await sleep(450);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
  expect(await src.count()).toBe(0);
});

// #243 (review rejection): leaving a revealed diagram DOWNWARD re-mounts it as an atom whose SVG
// renders ASYNC — it settles TALLER than the raw source it replaced. CM's heightMap tracks the growth (shared
// ResizeObserver → requestMeasure) but nothing re-anchored the SELECTION, so the caret line (directly below the
// now-taller widget) was pushed OFF the bottom of the viewport. `reAnchorAfterReveal` arms a one-shot scroll on
// the reveal→atom transition; the async settle consumes it and pulls the caret back on-screen. This is a real
// geometry assertion: without the fix the caret's client rect ends up below the viewport bottom.
test("#243 leaving a tall diagram downward keeps the caret on-screen after the async re-render settles", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 900, height: 440 } })).newPage();
  await openScratch(page, "reveal-reanchor");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // A TALL vertical mermaid: 16 stacked nodes → the rendered SVG is far taller than its ~19-line raw source.
  // `BELOWLINE` is the line the caret leaves onto; the trailing text keeps it from being the very last line.
  const chain = Array.from({ length: 16 }, (_, i) => `  N${i} --> N${i + 1}`).join("\n");
  await page.keyboard.insertText(`top\n\`\`\`mermaid\nflowchart TD\n${chain}\n\`\`\`\nBELOWLINE\ntail\n`);
  await sleep(1500); // the SVG mounts → the widget is tall while rendered
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();

  // Reveal the raw source (short) by clicking the diagram, then leave DOWNWARD in one motion (Ctrl+End →
  // doc end, below the fence). The moment the caret crosses out, the block re-mounts as the tall atom; its
  // SVG settles a beat LATER and would push the caret line off the bottom without the re-anchor.
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").click();
  await sleep(300);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").count()).toBe(0); // revealed (raw)
  await page.keyboard.press("Control+End"); // exit downward past the fence
  await sleep(1500); // async mermaid render + height settle + the re-anchor within the settle window

  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible(); // re-rendered (atom)
  const vh = page.viewportSize()!.height;
  const rect = await page.evaluate(() => {
    const c = document.querySelector("[data-pane=preview] .cm-cursor-primary") as HTMLElement | null;
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  });
  expect(rect, "no primary cursor rect").not.toBeNull();
  // the caret must sit WITHIN the viewport after the settle (pre-fix it was pushed hundreds of px below vh).
  expect(rect!.bottom, `caret bottom ${rect!.bottom} > viewport ${vh} (pushed off-screen)`).toBeLessThanOrEqual(vh);
  expect(rect!.top, `caret top ${rect!.top} < 0 (above viewport)`).toBeGreaterThanOrEqual(0);
});

test("#243: plantuml also reveals its raw source on caret-in (parity with mermaid)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "reveal-plantuml");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top\n```plantuml\n@startuml\nA -> B\n@enduml\n```\nbelow\n");
  await sleep(700);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-plantuml]")).toBeVisible();
  await page.locator("[data-pane=preview] [data-testid=macro-plantuml]").click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] [data-testid=macro-plantuml]").count()).toBe(0);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("```plantuml");
  await expect(page.locator("[data-pane=preview] [data-testid=fence-richui-enter]")).toBeVisible();
});
