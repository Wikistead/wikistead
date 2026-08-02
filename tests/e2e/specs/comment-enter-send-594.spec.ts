import { test, expect } from "@playwright/test";
import { API, openDemo, sleep } from "../helpers";

// #594 (user ruling): the comment composer takes the chat convention — Enter posts, Shift-Enter breaks
// the line. Before this there was no keyboard route at all: the button was the only way to post.
//
// What only a browser can answer is pinned here — that the key reaches the textarea and the comment
// lands, that Shift-Enter really writes a second line instead of posting, and that neither route posts
// twice. The IME rule (an Enter confirming a conversion must not post) is proved in mention-nav.test.ts
// with the flag the browser sets, because no test can drive a real IME; the user checks that one on a
// real machine.

async function composer(page: import("@playwright/test").Page) {
  await openDemo(page);
  const stamp = Date.now().toString(36);
  const pageId = await page.evaluate(async ({ api, stamp }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: `enter to send ${stamp}` }),
    });
    return ((await r.json()) as { id: string }).id;
  }, { api: API, stamp });
  await page.goto(`/p/${pageId}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  await page.click("[data-testid=page-overflow-trigger]");
  await page.click("[data-testid=comments-toggle]");
  await page.locator("[data-testid=page-overflow]").waitFor({ state: "detached" }).catch(() => {});
  const input = page.locator("[data-testid=comment-input]").last();
  await expect(input).toBeVisible({ timeout: 10_000 });
  await input.click();
  return input;
}

test("#594: Enter posts the comment", async ({ page }) => {
  const input = await composer(page);
  const body = `posted with the keyboard ${Date.now().toString(36)}`;
  await input.fill(body);
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid=comment-item]").filter({ hasText: body }), "the comment landed").toHaveCount(1, { timeout: 8000 });
  await expect(input, "and the composer is empty again").toHaveValue("");
});

test("#594: Shift-Enter writes a second line and posts nothing", async ({ page }) => {
  const input = await composer(page);
  await input.fill("first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await sleep(200);
  await expect(input, "a newline went in, not a post").toHaveValue(/first line\nsecond line/);
  await expect(page.locator("[data-testid=comment-item]"), "nothing was posted").toHaveCount(0);

  // and the two-line body posts as one comment when Enter finally comes
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid=comment-item]").filter({ hasText: "second line" })).toHaveCount(1, { timeout: 8000 });
});

test("#594: an empty composer posts nothing, and Enter does not double-post", async ({ page }) => {
  const input = await composer(page);
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await sleep(300);
  await expect(page.locator("[data-testid=comment-item]"), "whitespace is not a comment").toHaveCount(0);

  const body = `once only ${Date.now().toString(36)}`;
  await input.fill(body);
  await page.keyboard.press("Enter");
  // count POSTED comments, not text on the page: a textarea's own value matches a text locator, which
  // would make this pass with no posting at all
  await expect(page.locator("[data-testid=comment-item]").filter({ hasText: body })).toHaveCount(1, { timeout: 8000 });
  await page.keyboard.press("Enter"); // the composer is empty now — this must add nothing
  await sleep(400);
  await expect(page.locator("[data-testid=comment-item]").filter({ hasText: body }), "exactly one copy").toHaveCount(1);
});
