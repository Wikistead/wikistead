import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #505 / #207 / #85 (ADR-191). The ruling's acceptance is a single sentence: "every rendered element is
// in scope; none of them may break in print." This encodes it as a gate over the two STATIC surfaces the
// print sheet can come from — the client print portal and the server export.html — using one fixture that
// carries every element type we ship. It asserts the FAILURE MODES rather than pixels: nothing may reach
// paper as raw markdown (a leaked `:::`, a literal `[ ]`, a bare `$x$`), and each container must actually
// be there. Pixel-level convergence is the separate style work; this is the "nothing is broken" floor,
// and it is what regressions have historically slipped past.
const FIXTURE = [
  "# Heading",
  "",
  "Prose with **bold**, `code`, ==mark== and inline math $x^2$.",
  "",
  ":::note[Note]",
  "callout body",
  ":::",
  "",
  ":::todo",
  "- [ ] open task",
  "- [x] done task",
  ":::",
  "",
  "| H1 | H2 |",
  "| --- | --- |",
  "| a | b |",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "$$\\int_0^1 x\\,dx$$",
  "",
  "last line",
  "",
].join("\n");

// Nothing on a printed page may still be markdown source.
//
// KaTeX's MathML carries the TeX source in an inert <annotation> — it is metadata, never drawn — so the
// scan strips those first. Asserting on the raw string without that would fail on the very output that
// proves the math WAS rendered, and would say nothing about what the reader sees.
function assertNothingRaw(raw: string, where: string) {
  const surface = raw.replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/g, "");
  expect(surface, `${where}: a directive marker leaked`).not.toMatch(/:{3,}\w/);
  expect(surface, `${where}: a task marker leaked`).not.toMatch(/\[[ xX]\]/);
  expect(surface, `${where}: math delimiters leaked`).not.toMatch(/\$\$|\$x\^2\$/);
}

test("#505: the print surface renders every element (nothing reaches paper as raw markdown)", async ({ page }) => {
  const id = await openScratch(page, `parity505-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(FIXTURE);
  await sleep(1200);
  await publish(page, id);

  await page.emulateMedia({ media: "print" });
  await sleep(600);
  const portal = page.locator("[data-print-root]");
  await expect(portal).toBeVisible();

  const markup = (await portal.innerHTML()) || "";
  assertNothingRaw(markup, "print portal");

  // and the elements are actually present, as elements
  await expect(portal.locator(".callout, .cm-lp-callout"), "callout box").toHaveCount(1);
  await expect(portal.locator("input[type=checkbox]"), "both checklist items").toHaveCount(2);
  await expect(portal.locator("table"), "table").toHaveCount(1);
  await expect(portal.locator("pre"), "code fence").not.toHaveCount(0);
  await expect(portal.locator("math, .katex"), "inline + block math").not.toHaveCount(0);
});

test("#505: the HTML export renders the same elements (the path print folds onto)", async ({ page }) => {
  const id = await openScratch(page, `parity505x-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(FIXTURE);
  await sleep(1200);
  await publish(page, id);

  const html = await page.evaluate(async ({ api, pageId }) => {
    const r = await fetch(`${api}/pages/${pageId}/export.html`, { headers: { Authorization: "Bearer dev-token" } });
    return r.ok ? r.text() : `HTTP_${r.status}`;
  }, { api: API, pageId: id });
  expect(html.startsWith("HTTP_"), `export.html failed: ${html.slice(0, 40)}`).toBe(false);

  // scan the BODY only: the document carries a stylesheet, and CSS is not what reaches the reader
  const body = html.slice(html.indexOf("<body"));
  assertNothingRaw(body, "export.html body");
  expect(html, "callout box").toContain('class="callout');
  expect(html, "todo box").toContain('class="todo"');
  expect(html, "checkboxes").toContain('type="checkbox"');
  expect(html, "table").toContain("<table");
  expect(html, "code fence").toContain("<pre");
  expect(html, "math").toContain("<math");
});

// The export is the PUBLISHED body, so the fixture has to be published before either surface shows it.
async function publish(page: Page, id: string) {
  const status = await page.evaluate(async ({ api, pageId }) => {
    const r = await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
    return r.status;
  }, { api: API, pageId: id });
  expect([200, 201, 204]).toContain(status);
  await sleep(600);
}

// The THIRD surface: the editor's own live-preview. ADR-191 folds print onto the static renderer, but the
// screen is what the author judges the result against — so the gate has to say the same elements render
// there too. Drift here is what produced the bugs this work keeps finding (math rendered on one surface
// and not the other; a checklist that was checkboxes on screen and literal `[ ]` on paper).
test("#505: the editor surface renders the same element types (the third face of the parity)", async ({ page }) => {
  await openScratch(page, `parity505s-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(FIXTURE);
  await sleep(1400);
  await page.getByText("last line", { exact: true }).click(); // caret out of every block → all render
  await sleep(700);

  const cm = page.locator("[data-pane=preview] .cm-content");
  await expect(cm.locator(".cm-lp-callout"), "callout").not.toHaveCount(0);
  await expect(cm.locator("input[type=checkbox]"), "checklist").not.toHaveCount(0);
  await expect(cm.locator(".cm-lp-table, table"), "table").not.toHaveCount(0);
  await expect(cm.locator(".cm-lp-math, .katex, math"), "math").not.toHaveCount(0);
  // the fence renders as the code card (its header is the tell), not as raw ``` lines
  await expect(cm.locator(".cm-lp-code-line, .cm-lp-fence-card, .cm-lp-code-header"), "code card").not.toHaveCount(0);
});
