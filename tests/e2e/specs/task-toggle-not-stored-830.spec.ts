import { test, expect } from "@playwright/test";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #830: a checkbox ticked while the collaboration socket is dead used to STAY ticked, with nothing
// stored anywhere.
//
// The flip travels to the server through the live document, so a dead socket means it never reaches
// the persisted draft. The route then finds the draft and the published snapshot agreeing about that
// box and answers 409 `task_burst` — the code written for a fast clicker, whose flip IS published and
// whose tick must therefore be left alone. The client obeyed, and the reader was left looking at a
// tick that stood for nothing.
//
// Measured before the fix, in this exact walk: the box read checked and `published_md` still read
// `- [ ] ship it`.
//
// REAL BROWSER, on purpose: a unit test can assert what the route answers, and this is about what a
// person is looking at afterwards. The socket is REFUSED rather than the browser taken offline —
// offline would fail the POST too, which the client already reports honestly, and would prove nothing
// about the case that was silent.
type P = import("@playwright/test").Page;
const publishedMd = (p: P, id: string) =>
  p.evaluate(async ({ api, id }) => {
    const r = await fetch(`${api}/pages/${id}/published`, { headers: { Authorization: "Bearer dev-token" } });
    return ((await r.json()) as { publishedMd: string | null }).publishedMd;
  }, { api: API, id });
const publish = (p: P, id: string) =>
  p.evaluate(async ({ api, id }) => {
    await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, id });

test("#830: a tick that never reached the server does not stay on screen", async ({ browser }) => {
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Seed with a live socket, so the page really is published with one unchecked box.
  const pageId = await openScratch(page, "task-830");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.type("- [ ] ship it");
  await sleep(600);
  await publish(page, pageId);
  expect(await publishedMd(page, pageId)).toContain("- [ ] ship it");

  // From here the collaboration socket is refused. HTTP keeps working, which is the whole point.
  await page.routeWebSocket("**/collab**", () => { /* never connected upstream */ });
  await page.reload();
  await sleep(3000);

  const box = page.getByTestId("task-checkbox").first();
  await expect(box, "the published surface still renders without a live document").toBeVisible();
  await expect(box, "the box starts unchecked, as published says").not.toBeChecked();
  await expect(box, "and it is offered — which is why the tick has to be honest").toBeEnabled();

  await box.click();
  // The optimistic flip, the POST, the answer, and the settle that follows it.
  await expect(box, "the tick stood for nothing and was put back").not.toBeChecked({ timeout: 15_000 });

  expect(await publishedMd(page, pageId), "nothing was stored, which is what makes the tick a lie")
    .toContain("- [ ] ship it");
  await ctx.close();
});
