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
