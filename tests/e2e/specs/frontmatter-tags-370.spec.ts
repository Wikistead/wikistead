import { test, expect, type Page } from "@playwright/test";
import { enterEdit, openScratch, sleep } from "../helpers";

// #370 / ADR-145: frontmatter tags + the :::tagged / :::children dynamic lists. Real Chromium:
// the leading `---` fence renders as a tag-chip widget (not raw YAML), the chip editor writes ONE
// tags line, publish projects page_tags, and :::tagged lists the published pages carrying the tag.

const srcText = async (p: Page) => {
  await p.getByTestId("displaymode-source").click();
  await sleep(250);
  return p.locator("[data-pane=preview] .cm-content").innerText();
};

test("#370: frontmatter renders as a chip widget; the chip editor writes the tags line", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fm-widget");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("---\ntags: [alpha]\n---\n\nbody text\n");
  await sleep(400);
  // move the caret out of the frontmatter (caret inside reveals raw) — go to the body
  await page.keyboard.press("Control+End");
  await sleep(400);
  const widget = page.getByTestId("frontmatter-widget");
  await expect(widget).toBeVisible();
  await expect(page.getByTestId("fm-tag-alpha")).toBeVisible();
  // add a tag via the input (one offset-invariant write)
  await page.getByTestId("fm-tag-input").click();
  await page.keyboard.type("Beta");
  await page.keyboard.press("Enter");
  await sleep(300);
  await expect(page.getByTestId("fm-tag-beta")).toBeVisible();
  // remove alpha via the chip ×
  await page.getByTestId("fm-tag-remove-alpha").click();
  await sleep(300);
  await expect(page.getByTestId("fm-tag-alpha")).toHaveCount(0);
  const s = await srcText(page);
  expect(s).toContain("tags: [Beta]");
  expect(s).not.toContain("alpha");
});

test("#370: /tags palette command creates the frontmatter block at doc start", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fm-palette");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("some body first\n");
  await page.keyboard.type("/tags");
  await expect(page.getByTestId("slash-palette")).toBeVisible();
  await page.click('[data-testid="slash-item-page-tags"]');
  await sleep(300);
  const s = await srcText(page);
  expect(s.startsWith("---")).toBe(true);
  expect(s).toContain("tags: []");
  expect(s).toContain("some body first");
});

test("#370: vim dd on the frontmatter atom deletes the whole block as a unit", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "fm-vim-dd");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("---\ntags: [zap]\n---\n\nline one\nline two\n");
  await sleep(300);
  // enable vim via the toolbar toggle if present; else Ctrl+Alt+V
  await page.keyboard.press("Control+Alt+v");
  await sleep(300);
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg"); // to the top — lands ON the atom (doc-line motion)
  await sleep(200);
  await page.keyboard.type("dd"); // deletes the whole frontmatter block, not one fence line
  await sleep(400);
  const s = await srcText(page);
  expect(s).not.toContain("tags: [zap]");
  expect(s).not.toContain("---");
  expect(s).toContain("line one"); // the body is untouched
});

test("#370: :::tagged lists a published page carrying the tag; :::children lists child pages", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  // 1. a tagged page, published
  const tagged = await openScratch(page, "fm-tagged-member");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("---\ntags: [e2etag370]\n---\n\ntagged body\n");
  await sleep(300);
  await page.getByTestId("publish-page").click();
  await sleep(800);

  // 2. a hub page with a :::tagged block
  await openScratch(page, "fm-tagged-hub");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::tagged\ne2etag370\n:::\n\ntail\n");
  await page.keyboard.press("Control+End");
  await sleep(800);
  const item = page.locator(`[data-testid="macro-tagged-item-${tagged}"]`);
  await expect(item).toBeVisible({ timeout: 10000 });
  await expect(item).toHaveText("fm-tagged-member");
});

// #370(review return): `:::children` showed the generic "Empty children" placeholder and
// NEVER fired the host listSource fetch — its always-empty body was swallowed by the empty-macro branch
// (backlinks had the exemption; children didn't). This pins the real flow: a parent with PUBLISHED
// children renders the resolved list on the member edit surface.
test("#370:::children resolves and lists the published child pages (member edit surface)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const parent = await openScratch(page, "fm-children-parent");
  // two published children under the parent, via the API (deterministic fixture)
  const childIds = await page.evaluate(async ({ parent }) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const ids: string[] = [];
    for (const title of ["fm-child-A", "fm-child-B"]) {
      const r = await fetch(`http://dev.localhost:4010/spaces/demo_space/pages`, { method: "POST", headers: H, body: JSON.stringify({ title, parentId: parent }) });
      const { id } = (await r.json()) as { id: string };
      await fetch(`http://dev.localhost:4010/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
      ids.push(id);
    }
    return ids;
  }, { parent });

  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::children\n:::\n\ntail\n");
  await page.keyboard.press("Control+End");
  await sleep(800);
  // the widget must NOT be the generic empty-macro placeholder…
  await expect(page.getByTestId("macro-empty")).toHaveCount(0);
  // …but the host-resolved list with both children
  for (const id of childIds) {
    await expect(page.locator(`[data-testid="macro-children-item-${id}"]`)).toBeVisible({ timeout: 10000 });
  }
});

// #370(review return): `:::children` is a DESCENDANT TREE (grandchildren nested via real
// sub-<ul>s), and the list wears NO box chrome (border/panel wash) — a plain Markdown bullet list.
test("#370:::children nests grandchildren and renders without the box chrome", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const parent = await openScratch(page, "fm-children-tree");
  const { child, grand } = await page.evaluate(async ({ parent }) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const mk = async (title: string, parentId: string) => {
      const r = await fetch(`http://dev.localhost:4010/spaces/demo_space/pages`, { method: "POST", headers: H, body: JSON.stringify({ title, parentId }) });
      const { id } = (await r.json()) as { id: string };
      await fetch(`http://dev.localhost:4010/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
      return id;
    };
    const child = await mk("fm-tree-child", parent);
    const grand = await mk("fm-tree-grand", child);
    return { child, grand };
  }, { parent });

  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::children\n:::\n\ntail\n");
  await page.keyboard.press("Control+End");
  await sleep(800);
  const childItem = page.locator(`[data-testid="macro-children-item-${child}"]`);
  const grandItem = page.locator(`[data-testid="macro-children-item-${grand}"]`);
  await expect(childItem).toBeVisible({ timeout: 10000 });
  await expect(grandItem).toBeVisible();
  // the grandchild sits in a nested sub-list UNDER the child's <li> (real tree structure)…
  const nested = await grandItem.evaluate((el) => !!el.closest("ul.cm-lp-backlinks-sub"));
  expect(nested, "grandchild rendered inside a nested sub-<ul>").toBe(true);
  // …and physically indented relative to the top-level item
  const cb = (await childItem.boundingBox())!;
  const gb = (await grandItem.boundingBox())!;
  expect(gb.x, "nested item is indented").toBeGreaterThan(cb.x + 8);
  // Issue 2: no box chrome — transparent background, no border, and REAL list bullets
  const box = page.locator("[data-testid=macro-children]").first();
  const style = await box.evaluate((el) => {
    const s = getComputedStyle(el);
    const ul = getComputedStyle(el.querySelector("ul")!);
    return { bg: s.backgroundColor, borderW: s.borderTopWidth, listStyle: ul.listStyleType };
  });
  expect(style.bg, "no panel wash").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  expect(style.borderW, "no border").toBe("0px");
  expect(style.listStyle, "plain markdown bullets").toBe("disc");
});

// #370`:::children` NESTED in a container (details / columns) must resolve — the list-host seam
// now threads the same view-filtered listSource into the nested (md-render) path, so the nested macro
// renders the REAL list (grandchildren nested) instead of a dead placeholder.
test("#370:::children nested in details and columns resolves the real list", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const parent = await openScratch(page, "fm-children-nested-seam");
  const { child, grand } = await page.evaluate(async ({ parent }) => {
    const H = { Authorization: "Bearer dev-token", "content-type": "application/json" };
    const mk = async (title: string, parentId: string) => {
      const r = await fetch(`http://dev.localhost:4010/spaces/demo_space/pages`, { method: "POST", headers: H, body: JSON.stringify({ title, parentId }) });
      const { id } = (await r.json()) as { id: string };
      await fetch(`http://dev.localhost:4010/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
      return id;
    };
    const child = await mk("fm-seam-child", parent);
    const grand = await mk("fm-seam-grand", child);
    return { child, grand };
  }, { parent });

  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(":::details[Kids]\n:::children\n:::\n:::\n\n::::columns\n:::column\n:::children\n:::\n:::\n:::column\nplain\n:::\n::::\n\ntail\n");
  await page.keyboard.press("Control+End");
  await sleep(1200); // nested renders + async fetches settle

  // the details body holds a RESOLVED list (attached even while collapsed), grandchild nested
  const detailsList = page.locator("[data-testid=macro-details] [data-testid=macro-children]").first();
  await expect(detailsList).toBeAttached({ timeout: 10000 });
  await expect(detailsList.locator(`[data-testid="macro-children-item-${child}"]`)).toBeAttached();
  await expect(detailsList.locator(`[data-testid="macro-children-item-${grand}"]`)).toBeAttached();
  // the column shows it VISIBLY
  const colList = page.locator(".cm-lp-column [data-testid=macro-children]").first();
  await expect(colList).toBeVisible({ timeout: 10000 });
  await expect(colList.locator(`[data-testid="macro-children-item-${child}"]`)).toBeVisible();
  // and no dead placeholder remains anywhere
  await expect(page.locator(".cm-lp-query-placeholder")).toHaveCount(0);
});
