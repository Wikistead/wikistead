import { test, expect, type Browser } from "@playwright/test";
import { enterEdit, createScratchPage, sleep } from "../helpers";

// The <Editor/> isolation invariant + lifecycle robustness.
test("editor isolation: typing doesn't re-render React; rapid page switch leaks nothing", async ({ browser }: { browser: Browser }) => {
  const O = await (await browser.newContext()).newPage(); // observer, stays put
  const E = await (await browser.newContext()).newPage(); // editor, switches pages

  // client-side route switch (no full reload)
  const nav = (page: typeof E, path: string) =>
    page.evaluate((p) => { history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);

  // Two REAL throwaway pages (unique docs → no shared-demo ghost). A non-existent page
  // is no longer an editable phantom, so the test edits real pages in a space.
  await O.goto("/p/demo");
  await O.waitForSelector("[data-pane=preview] .cm-content");
  const a = await createScratchPage(O, "fdn-a");
  const b = await createScratchPage(O, "fdn-b");

  await O.goto(`/p/${a}`);
  await E.goto(`/p/${a}`);
  for (const p of [O, E]) await p.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(1200);

  // The observer must be on the COLLAB surface to see remote carets: view mode now
  // renders the published snapshot (no collab), where awareness carets don't appear.
  await enterEdit(O);

  // P3: reveal the editable surface (dev-token = edit capability). Capture the
  // render baseline AFTER this deliberate mode change, so we measure ONLY typing.
  await enterEdit(E);
  // typing must NOT re-render the React <Editor> (content lives in Y.Text/CM)
  const r0 = await E.evaluate(() => (window as any).__editorRenders ?? 0);
  await E.click("[data-pane=preview] .cm-content");
  await E.keyboard.type("the quick brown fox");
  await sleep(300);
  const r1 = await E.evaluate(() => (window as any).__editorRenders ?? 0);
  expect(r1).toBe(r0);

  // rapid A->B->A switching: observer must see exactly ONE remote caret (a leaked
  // provider / ghost cursor would push this above 1).
  for (let i = 0; i < 5; i++) {
    await nav(E, `/p/${b}`);
    await sleep(250);
    await nav(E, `/p/${a}`);
    await E.waitForSelector("[data-pane=preview] .cm-content");
    // Each page switch remounts <Editor> (new docName key) → mode resets to view;
    // re-enter edit so the caret/selection is published to the observer.
    await enterEdit(E);
    await E.click("[data-pane=preview] .cm-content");
    await E.keyboard.press("ArrowRight");
    await sleep(250);
  }
  await sleep(800);
  const ghosts = await O.evaluate(() => document.querySelectorAll("[data-pane=preview] .cm-ySelectionCaret").length);
  expect(ghosts).toBe(1);
});
