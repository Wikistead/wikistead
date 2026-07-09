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
