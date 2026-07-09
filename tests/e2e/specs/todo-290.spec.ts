import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const content = (p: import("@playwright/test").Page) => p.locator("[data-pane=preview] .cm-content").innerText();

// #290 / ADR-114: the :::todo directive — the PROMOTED form of a plain GFM task list — renders as a
// tinted CONTAINER box on the LINE path (NOT a callout panel), so its body stays a real CM-rendered GFM task
// list with INTERACTIVE checkboxes (ADR-019 unchanged). The header shows the [title]; the progress ring is a
// follow-up open-line decoration (kept off the panel path precisely so the checkboxes stay interactive).
test("#290: :::todo renders a container box whose body checkboxes stay interactive", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "todo-box");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [x] alpha\n- [ ] beta\n- [ ] gamma\n:::\n\nbelow\n");
  await sleep(400);
  await page.getByText("below").click(); // caret off the block → the body lines render (checkboxes shown)
  await sleep(200);

  // the block is a :::todo container box (line path, not a callout panel), and the ::: source is hidden
  await expect(page.locator("[data-pane=preview] .cm-lp-todo").first()).toBeVisible();
  expect(await content(page)).not.toContain(":::todo"); // the fence markers are hidden
  // the open line shows the [title] via the directive-label header
  await expect(page.locator("[data-pane=preview] .cm-lp-todo.cm-lp-directive-label[data-label='Sprint']")).toHaveCount(1);
  // the open line shows a PROGRESS RING computed from THIS block's checkboxes: 1 of 3 done.
  const ring = page.locator("[data-pane=preview] [data-testid=todo-ring]");
  await expect(ring).toHaveCount(1);
  await expect(ring).toHaveAttribute("data-done", "1");
  await expect(ring).toHaveAttribute("data-total", "3");
  await expect(ring.locator(".cm-lp-todo-ring-label")).toHaveText("1/3");

  // the body is a real GFM task list → INTERACTIVE checkboxes (ADR-019), one per task, first one checked
  const boxes = page.getByTestId("task-checkbox");
  await expect(boxes).toHaveCount(3);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).not.toBeChecked();

  // clicking a box flips the draft (the ADR-019 path works INSIDE :::todo) AND the ring recomputes to 2/3
  await boxes.nth(1).click();
  await sleep(200);
  await expect(boxes.nth(1)).toBeChecked();
  await expect(page.locator("[data-pane=preview] [data-testid=todo-ring]")).toHaveAttribute("data-done", "2");
});

// #290 / ADR-114: PROMOTION — Ctrl+Enter on a plain GFM task-list block wraps it in :::todo (the
// table-precedent explicit promotion). The plain list keeps its interactive checkboxes throughout.
test("#290: Ctrl+Enter promotes a plain task list to :::todo", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "todo-promote");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("- [ ] alpha\n- [ ] beta\nbelow"); // insertText: no Enter list-continuation
  await sleep(200);
  await page.keyboard.press("ArrowUp"); // caret onto the "beta" task line (the block)
  await sleep(100);
  await page.keyboard.press("Control+Enter"); // promote the contiguous task-list block
  await sleep(200);
  await page.keyboard.type("Mine"); // the caret landed inside :::todo[] → type the title

  // the source is now a :::todo wrapping the plain task list (Open formats — the list is unchanged)
  await page.getByTestId("displaymode-source").click();
  await sleep(200);
  const src = await content(page);
  expect(src).toContain(":::todo[Mine]");
  expect(src).toContain("- [ ] alpha");
  expect(src).toContain("- [ ] beta");
  expect(src).toContain("below"); // the following line is untouched

  // back to Live: it renders as a :::todo box with a 0/2 ring
  await page.getByTestId("displaymode-live").click();
  await sleep(200);
  await page.getByText("below").click();
  await sleep(150);
  await expect(page.locator("[data-pane=preview] .cm-lp-todo").first()).toBeVisible();
  const ring = page.locator("[data-pane=preview] [data-testid=todo-ring]");
  await expect(ring).toHaveAttribute("data-total", "2");
  await expect(ring).toHaveAttribute("data-done", "0");
});

// #290 / ADR-114: DEMOTION — the header ✕ "remove ring" button unwraps a :::todo back to a plain
// GFM task list (explicit, never auto). The task list (and its checkboxes) survive; the ring/title are gone.
test("#290: the header ✕ demotes a :::todo back to a plain task list", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "todo-demote-btn");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [x] alpha\n- [ ] beta\n:::\n\nbelow\n");
  await sleep(400);
  await page.getByText("below").click(); // caret off → the todo box + header render
  await sleep(200);

  const todo = page.locator("[data-pane=preview] .cm-lp-todo").first();
  await todo.hover(); // reveal the hover-gated header button
  await sleep(120);
  await page.getByTestId("todo-demote").first().click({ force: true });
  await sleep(250);

  // the :::todo wrapper is gone; the plain task list (with its checkbox state) remains
  await page.getByTestId("displaymode-source").click();
  await sleep(200);
  const src = await content(page);
  expect(src).not.toContain(":::todo");
  expect(src).toContain("- [x] alpha");
  expect(src).toContain("- [ ] beta");
});

// #290 / ADR-114 (increment A): the TITLE BAND shows a page-progress ring aggregating ALL the page's GFM
// checkboxes (inside or outside a :::todo). Live-computed from the doc (the onHeadings-style seam, dedup'd —
// not the dirty-signal path), so it updates as the page changes. Shown only when the page has checkboxes.
test("#290 (A): the title band shows a live page-progress ring from the page's checkboxes", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "page-ring");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("- [x] done one\n- [ ] todo two\n- [ ] todo three\n");
  await sleep(400);

  // 1 of 3 done → the title-band ring reads 1/3.
  const ring = page.getByTestId("page-task-ring");
  await expect(ring).toHaveCount(1);
  await expect(ring).toHaveAttribute("data-total", "3");
  await expect(ring).toHaveAttribute("data-done", "1");
  await expect(ring.locator(".cm-lp-todo-ring-label")).toHaveText("1/3");

  // add another DONE task → the ring updates live to 2/4 (no reload).
  await page.keyboard.insertText("- [x] done four\n");
  await sleep(300);
  await expect(page.getByTestId("page-task-ring")).toHaveAttribute("data-total", "4");
  await expect(page.getByTestId("page-task-ring")).toHaveAttribute("data-done", "2");
});

// #290 (A): a page with NO checkboxes shows NO page ring (0/0 → nothing, per ADR-114).
test("#290 (A): no page ring when the page has no checkboxes", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "page-ring-none");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("# Just a heading\n\nsome prose, no tasks\n");
  await sleep(400);
  expect(await page.getByTestId("page-task-ring").count()).toBe(0);
});

// #290 / ADR-114: the SIDEBAR tree shows a compact progress ring on pages that contain a :::todo
// (only those — the aggregate counts :::todo-block checkboxes, so it's self-gating). Persisted on publish
// (task_done/task_total columns) so the tree query stays cheap. Real Chromium, full publish → refetch path.
test("#290: the sidebar shows a :::todo progress ring on a published page (persisted aggregate)", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const name = `todo-sidebar-${Date.now()}`;
  await openScratch(page, name);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [x] a\n- [ ] b\n:::\n");
  await sleep(300);
  await page.getByTestId("publish-page").click(); // publish → task_done/task_total persisted → tree refetch
  await sleep(800);

  // the scratch page's tree row now carries a compact todo ring reading 1/2.
  const row = page.getByTestId("tree-page-name").filter({ hasText: name }).locator("..");
  const ring = row.getByTestId("tree-todo-ring").locator("[data-testid=page-task-ring]");
  await expect(ring).toHaveAttribute("data-done", "1", { timeout: 6000 });
  await expect(ring).toHaveAttribute("data-total", "2");
});

// Round-trip: :::todo source is preserved (Source display mode shows the raw directive + task list).
test("#290: :::todo round-trips as plain :::todo + a GFM task list (Open formats)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "todo-roundtrip");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Plan]\n- [ ] one\n- [ ] two\n:::\n");
  await sleep(300);
  await page.getByTestId("displaymode-source").click();
  await sleep(200);
  const src = await content(page);
  expect(src).toContain(":::todo[Plan]");
  expect(src).toContain("- [ ] one");
  expect(src).toContain("- [ ] two");
});

// ── #290 review re-work (geometry, direct palette, multi-block) ────────

// #290 (review point 1): the :::todo HEADER ring is VERTICALLY CENTERED on its line — verified by
// geometry (ring center Y vs the line box center Y ≤1px), not by eye (#174 lesson).
test("#290: the :::todo header ring is vertically centered on its line (geometry ≤1px)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "todo-ring-center");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [x] a\n- [ ] b\n:::\n\nbelow\n");
  await sleep(300);
  const ring = page.locator("[data-pane=preview] [data-testid=todo-ring]");
  await expect(ring).toBeVisible();
  const dy = await ring.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const line = el.closest(".cm-line")!.getBoundingClientRect();
    return Math.abs((r.top + r.height / 2) - (line.top + line.height / 2));
  });
  expect(dy).toBeLessThanOrEqual(1.5); // ring mid-line aligned with the header line's mid
});

// #290 (review point 1): the SIDEBAR ring is vertically centered in its tree row — geometry vs the row
// title's center Y (both should sit on the row's mid-line).
test("#290: the sidebar :::todo ring is vertically centered in its tree row (geometry ≤1.5px)", async ({ browser }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const name = `todo-ring-side-${Date.now()}`;
  await openScratch(page, name);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Sprint]\n- [x] a\n- [ ] b\n:::\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);
  const row = page.getByTestId("tree-page-name").filter({ hasText: name }).locator("..");
  const ring = row.getByTestId("tree-todo-ring");
  await expect(ring.locator("[data-testid=page-task-ring]")).toHaveAttribute("data-done", "1", { timeout: 6000 });
  const dy = await ring.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const nameEl = el.parentElement!.querySelector('[data-testid="tree-page-name"]')!.getBoundingClientRect();
    return Math.abs((r.top + r.height / 2) - (nameEl.top + nameEl.height / 2));
  });
  expect(dy).toBeLessThanOrEqual(1.5); // ring mid aligned with the row title's mid → centered in the row
});

// #290 (review point 2): a DIRECT palette entry inserts the rich :::todo (caret in the title), distinct
// from the plain /todo. The plain→rich promotion path is unchanged.
test("#290: the palette 'Todo (ring)' entry inserts a rich :::todo directly, caret in the title", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "todo-palette");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("/todo");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.locator('[data-testid="slash-item-todo-ring"]').click(); // the new direct entry
  await sleep(200);
  await page.keyboard.type("Sprint"); // the caret landed inside :::todo[] → type the title
  await sleep(150);
  await page.getByTestId("displaymode-source").click();
  await sleep(200);
  const src = await content(page);
  expect(src).toContain(":::todo[Sprint]"); // rich directive inserted with the typed title
  expect(src).toContain("- [ ] "); // a seed task line
});

// #290 (review point 4): multiple :::todo blocks + a task OUTSIDE any block — each header ring counts
// its OWN block, the page ring sums ALL checkboxes (global ordinal). Pins the multi-block spec.
test("#290: multiple :::todo blocks — each header ring is independent; the page ring sums all", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "todo-multi");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  // block One 1/2 · block Two 2/3 · outside 0/1 → page = 3/6
  await page.keyboard.insertText(":::todo[One]\n- [x] a\n- [ ] b\n:::\n\n:::todo[Two]\n- [x] c\n- [x] d\n- [ ] e\n:::\n\n- [ ] outside\n\nend\n");
  await sleep(400);
  const rings = page.locator("[data-pane=preview] [data-testid=todo-ring]");
  await expect(rings).toHaveCount(2);
  // (a) each header ring counts only its own block
  await expect(rings.nth(0)).toHaveAttribute("data-done", "1");
  await expect(rings.nth(0)).toHaveAttribute("data-total", "2");
  await expect(rings.nth(1)).toHaveAttribute("data-done", "2");
  await expect(rings.nth(1)).toHaveAttribute("data-total", "3");
  // (b) the page ring (title band) sums ALL checkboxes: both blocks + the outside task → 3/6. The
  // page-task-ring testid is shared with the sidebar rings of OTHER (previously-published) pages, so scope by
  // this page's unique total (6) — asserting that total, plus done=3, verifies the global sum.
  const pageRing = page.locator('[data-testid=page-task-ring][data-total="6"]');
  await expect(pageRing).toHaveCount(1);
  await expect(pageRing).toHaveAttribute("data-done", "3");
});

// ── #290review re-work (page-ring center, 100% checkmark, pop-on-toggle-only) ──

//(3): the TITLE-BAND page ring was still off-centre (only fixed the header + sidebar rings). It
// must sit on the meta row's mid-line — geometry vs the row box center Y (the svg baseline sink is the cause;
// display:block fixes it). On a fresh scratch page the only page-task-ring is the band one (no sidebar rings).
test("#290(3): the title-band page ring is vertically centered on the meta row (geometry ≤1.5px)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "page-ring-center");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("- [x] done one\n- [ ] todo two\n");
  await sleep(400);
  // page-task-ring is shared with the sidebar tree rings of OTHER published pages; the BAND ring is the one
  // NOT inside a tree-todo-ring. Measure its center vs its meta row (the "flex items-center gap-2" wrapper).
  const dy = await page.evaluate(() => {
    const band = Array.from(document.querySelectorAll("[data-testid=page-task-ring]")).find((e) => !e.closest("[data-testid=tree-todo-ring]"));
    if (!band) return null;
    const r = band.getBoundingClientRect();
    const row = band.parentElement!.getBoundingClientRect();
    return Math.abs((r.top + r.height / 2) - (row.top + row.height / 2));
  });
  expect(dy, "no band page-ring found").not.toBeNull();
  expect(dy!).toBeLessThanOrEqual(1.5);
});

//(1): a full (100%) ring shows a checkmark ✓ in its centre; below 100% there is none. (The draw-in
// animation on the completion transition is prefers-reduced-motion-gated device polish; here we assert the
// checkmark's PRESENCE at 100% and ABSENCE below, which is deterministic.)
test("#290(1): the progress ring shows a checkmark when it reaches 100%", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "ring-checkmark");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::todo[Done soon]\n- [x] a\n- [ ] b\n:::\n\nbelow\n");
  await sleep(400);

  const ring = page.locator("[data-pane=preview] [data-testid=todo-ring]");
  await expect(ring).toHaveAttribute("data-total", "2");
  await expect(ring).toHaveAttribute("data-done", "1");
  expect(await ring.locator(".cm-lp-todo-ring-check").count(), "no checkmark below 100%").toBe(0);

  // tick the last box → 2/2 → the checkmark appears in the ring.
  await page.getByTestId("task-checkbox").nth(1).click();
  await sleep(300);
  await expect(page.locator("[data-pane=preview] [data-testid=todo-ring]")).toHaveAttribute("data-done", "2");
  await expect(page.locator("[data-pane=preview] [data-testid=todo-ring] .cm-lp-todo-ring-check")).toHaveCount(1);
});

//(2): the check-ON pop must fire on a real TOGGLE, never on a reveal re-mount (the old `:checked` CSS
// animation replayed every time the caret entered/left the line). Count `wks-cb-pop` animationstart events:
// a reveal cycle over a CHECKED box must not fire it; a genuine check-ON must.
test("#290(2): the checkbox pop fires on toggle, not on reveal", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "cb-pop");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("- [x] alpha\n\nbeta\n"); // caret on "beta" → line 1 (checked) rendered, not revealed
  await sleep(300);
  await page.evaluate(() => {
    (window as unknown as { __cbPops: number }).__cbPops = 0;
    document.querySelector("[data-pane=preview] .cm-content")!.addEventListener("animationstart", (e) => {
      if ((e as AnimationEvent).animationName === "wks-cb-pop") (window as unknown as { __cbPops: number }).__cbPops++;
    }, true);
  });

  // reveal cycle: caret INTO the checked task line (reveals raw → box drops) then OUT (box re-mounts checked).
  await page.getByText("alpha").click();
  await sleep(150);
  await page.getByText("beta", { exact: true }).click();
  await sleep(250);
  expect(await page.evaluate(() => (window as unknown as { __cbPops: number }).__cbPops), "reveal must NOT pop").toBe(0);

  // a genuine toggle-ON pops exactly once: turn the box OFF (no pop), then ON (pop).
  const box = page.getByTestId("task-checkbox").first();
  await box.click(); // checked → unchecked (OFF, no pop)
  await sleep(200);
  await page.getByTestId("task-checkbox").first().click(); // unchecked → checked (ON → pop)
  await sleep(250);
  expect(await page.evaluate(() => (window as unknown as { __cbPops: number }).__cbPops), "a real toggle-ON pops once").toBe(1);
});
