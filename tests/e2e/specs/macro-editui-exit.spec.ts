import { test, expect } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #239: a fence macro's inline editUI (mermaid/plantuml — a plain textarea with no exit of its own)
// was a TRAP: opening it via ✎ mounted the editor but there was NO way back to the rendered diagram
// (the widget's ignoreEvent()=true swallows Escape before the editor-level handler runs). The host now
// wires an exit (Escape + a Done button) that commits (blur→change→save) and re-renders the macro.
async function openMermaidEditUI(page: any) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("```mermaid\nflowchart TD\n  A --> B\n```\n\nbelow\n");
  await sleep(500);
  await page.locator("[data-pane=preview] [data-testid=macro-mermaid]").hover();
  await sleep(150);
  await page.locator("[data-pane=preview] [data-testid=macro-edit]").first().click({ force: true });
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]")).toBeVisible();
}

test("#239: Escape exits the mermaid editUI back to the rendered diagram (and commits the edit)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-esc");
  await enterEdit(page);
  await openMermaidEditUI(page);
  await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("flowchart TD\n  X --> Y");
  await sleep(200);
  await page.keyboard.press("Escape");
  await sleep(600);
  // back to the rendered widget, textarea gone
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
  expect(await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").count()).toBe(0);
  // the edit committed to the doc (read raw via Source)
  await page.getByTestId("displaymode-source").click();
  await sleep(250);
  expect(await page.locator("[data-pane=preview] .cm-content").innerText()).toContain("X --> Y");
});

test("#239: the Done button exits the editUI back to the rendered diagram", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-done");
  await enterEdit(page);
  await openMermaidEditUI(page);
  await expect(page.locator("[data-pane=preview] [data-testid=editui-done]")).toBeVisible();
  await page.locator("[data-pane=preview] [data-testid=editui-done]").click({ force: true });
  await sleep(600);
  await expect(page.locator("[data-pane=preview] [data-testid=macro-mermaid]")).toBeVisible();
  expect(await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").count()).toBe(0);
});

// #282: typing in the mermaid editUI must not COLLAPSE the live preview pane (the "right half flickers").
// A mid-typing invalid diagram used to shrink the preview to a 1-line error and bounce back, flashing the
// pane and toggling the scrollbar. Fix: hold the pane's height (min-height) during the async re-render +
// debounce the render. The height collapse IS measurable headless; the scrollbar flash itself needs a
// classic (space-taking) scrollbar which headless lacks (see the ticket) → that stays a human check.
test("#282: the mermaid editUI preview holds its height while typing an invalid diagram (no collapse)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-282");
  await enterEdit(page);
  await openMermaidEditUI(page);
  const preview = page.locator("[data-pane=preview] [data-testid=mermaid-edit-preview]");
  await sleep(500); // the initial valid diagram renders → a real preview height
  const h0 = await preview.evaluate((el) => el.getBoundingClientRect().height);
  expect(h0).toBeGreaterThan(40); // a rendered SVG, not collapsed

  // Replace the source with text mermaid can't parse — the debounced render fails …
  await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.type("this is definitely not a valid mermaid diagram");
  await sleep(500); // > debounce (150ms) + render
  const h1 = await preview.evaluate((el) => el.getBoundingClientRect().height);
  // … but the pane HELD its height (min-height) instead of collapsing to the 1-line error.
  expect(h1).toBeGreaterThanOrEqual(h0 - 8);
});

// #282 (3rd cause,): mermaid.render with no container appends a ~150px in-flow node at <body> for
// text measurement; with no overflow clamp on html/body the WINDOW overflows and its scrollbar flashes
// ("a scrollbar further right, appearing and vanishing"). This IS machine-checkable headless (contrary to
// the earlier "human only" note): watch <body>'s direct children for an in-flow node added mid-render, and
// watch the document's overflow. The off-flow sandbox (position:fixed, visibility:hidden) must keep both 0.
test("#282: each mermaid render measures off-flow — no in-flow node hits <body>, the window never overflows", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "editui-282-body");
  await enterEdit(page);
  await openMermaidEditUI(page);
  await sleep(400);
  // Install the watcher AFTER mount so we only measure the renders we trigger below.
  await page.evaluate(() => {
    const rec = { inflow: 0, baseOver: document.documentElement.scrollHeight - document.documentElement.clientHeight, maxOver: 0 };
    (window as Window & typeof globalThis & { __wks282?: typeof rec }).__wks282 = rec;
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of Array.from(m.addedNodes)) {
          if (n.nodeType !== 1) continue;
          const el = n as HTMLElement;
          if (el.parentElement !== document.body) continue; // only DIRECT body children
          const cs = getComputedStyle(el);
          // an in-flow, space-taking, visible node is what overflows the window
          if ((cs.position === "static" || cs.position === "relative") && cs.visibility !== "hidden" && el.offsetHeight > 0) rec.inflow++;
        }
      }
      const over = document.documentElement.scrollHeight - document.documentElement.clientHeight;
      if (over > rec.maxOver) rec.maxOver = over;
    });
    mo.observe(document.body, { childList: true });
  });
  // Fire several distinct renders (each a fresh mermaid.render → a fresh measuring node).
  await page.locator("[data-pane=preview] [data-testid=mermaid-edit-src]").click();
  for (const t of ["flowchart TD\n  A-->B\n  B-->C", "flowchart LR\n  X-->Y", "flowchart TD\n  P-->Q\n  Q-->R\n  R-->S"]) {
    await page.keyboard.press("Control+a");
    await page.keyboard.type(t);
    await sleep(350); // > debounce + render
  }
  const rec = await page.evaluate(() => (window as Window & typeof globalThis & { __wks282?: { inflow: number; baseOver: number; maxOver: number } }).__wks282!);
  expect(rec.inflow, "mermaid appended an in-flow node to <body> during render (window scrollbar flash)").toBe(0);
  expect(rec.maxOver, "the document overflowed vertically during a render").toBeLessThanOrEqual(rec.baseOver + 2);
});
