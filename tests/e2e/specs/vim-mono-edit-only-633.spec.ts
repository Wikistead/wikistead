import { test, expect, type Page } from "@playwright/test";
import { openDemo, openScratch, enterEdit, sleep, API } from "../helpers";

// #633/the column grid belongs to the time spent EDITING, and it belongs to guests too.
//
// The pins that came with the feature set `data-vim-mono` by hand and then measured the face. That
// proves the stylesheet reads the marker; it proves nothing about whether the app ever puts it there,
// which is the half both rulings are about. So nothing here touches an attribute: vim is turned on
// through the toolbar, edit mode is entered and left through the toolbar, and the face is read off the
// surface. A share link is opened in a context of its own — a guest's vim has no server profile behind
// it, which is exactly the input that would be missing if this were wired through the member path only.
const bodyFace = () => `(() => {
  const el = document.querySelector('.cm-content');
  return el ? getComputedStyle(el).fontFamily : null;
})()`;

const readFace = (p: Page) => p.evaluate(bodyFace()) as Promise<string | null>;

/** Wait for the swap rather than sampling: with `font-display: swap` the file arrives after the rule. */
async function faceBecomes(p: Page, family: string) {
  await p.waitForFunction(`${bodyFace()}?.includes(${JSON.stringify(family)})`, undefined, { timeout: 12_000 })
    .catch(() => { /* asserted by the caller, with the value in the message */ });
}

test("#633: reading a page keeps prose proportional, even with vim on", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => { try { localStorage.removeItem("wks.editorVim"); } catch { /* private */ } });
  await openScratch(page, `vimmono633-${Date.now()}`);
  await enterEdit(page);
  await page.getByTestId("vim-toggle").click();
  await sleep(400);
  await faceBecomes(page, "UDEV");
  expect(await readFace(page), "editing with vim on: the column grid").toContain("UDEV");

  // …and leaving the editor gives the reading face back. This is the ruling: most of the time with this
  // product is spent reading, and a font nobody can choose should not also be the harder one to read.
  await page.getByTestId("view-toggle").click();
  await sleep(800);
  const reading = await readFace(page);
  expect(reading, `left the editor with vim still on :: ${reading}`).toContain("Inter");
  expect(reading, "…and the grid went with the editor").not.toContain("UDEV");

  // back in, and it returns — the marker is not one-way
  await enterEdit(page);
  await faceBecomes(page, "UDEV");
  expect(await readFace(page), "re-entering brings it back").toContain("UDEV");
});

test("#633: the swap to the grid leaves the editor's geometry agreeing with the screen", async ({ page }) => {
  test.setTimeout(180_000);
  // Entering edit now changes the face, and the file arrives AFTER the surface has been laid out
  // (`font-display: swap`). CodeMirror keeps its own height map, so a face that lands late is the shape
  // that would leave it describing lines that are no longer that tall — and the reader finds the caret
  // a line away from where they clicked. Measured on a document long enough for a per-line error to
  // accumulate into something visible.
  //
  // What this actually found, honestly: the hazard does not reproduce. Injecting a metric change far
  // larger than a face swap AFTER the surface had settled (26px, line-height 2.4, `!important`, with no
  // notification to CodeMirror at all) still landed the click on the right line — CodeMirror re-measures
  // on its own. So this is a green nobody has been able to turn red, which makes it a record of the
  // round trip rather than a guard, and it is written down that way instead of claimed as a guard.
  await page.addInitScript(() => { try { localStorage.removeItem("wks.editorVim"); } catch { /* private */ } });
  await openScratch(page, `vimgeom633-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(Array.from({ length: 25 }, (_, i) => `line ${i} of the document`).join("\n"));
  await sleep(600);
  await page.getByTestId("vim-toggle").click();
  await faceBecomes(page, "UDEV");
  await sleep(400);

  // click the text of a line far down the document, and ask which line the editor thinks that was
  const landed = await page.evaluate(() => {
    const lines = [...document.querySelectorAll<HTMLElement>("[data-pane=preview] .cm-line")];
    const target = lines[20];
    if (!target) return null;
    const r = target.getBoundingClientRect();
    return { text: target.textContent, top: r.top, bottom: r.bottom, x: r.left + 4, y: r.top + r.height / 2 };
  });
  expect(landed, "the document really has twenty lines to click past").not.toBeNull();
  await page.mouse.click(landed!.x, landed!.y);
  await sleep(300);

  // Asked of the editor's own model rather than of a caret element: in vim the caret is a block drawn by
  // a different layer, and the first attempt read a `.cm-cursor` whose rect was 0 — which would have
  // reported a defect that was really a wrong selector. What matters is which line the EDITOR decided
  // was clicked, and that is a document position.
  const decided = await page.evaluate(() => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as
      { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as
      { state: { selection: { main: { head: number } }; doc: { lineAt(p: number): { number: number } } } } | undefined;
    if (!view) return null;
    return view.state.doc.lineAt(view.state.selection.main.head).number;
  });
  expect(decided, "the editor exposes its view").not.toBeNull();
  expect(decided, `clicked "${landed!.text}" (line 21) and the editor put the cursor on line ${decided}`)
    .toBe(21);
});

test("#633: a share-link guest gets the same rule, with no profile to read it from", async ({ browser }) => {
  test.setTimeout(180_000);
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await member.evaluate(async (api) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "guest vim mono page" }),
    });
    return (await r.json()).id as string;
  }, API);
  await member.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId });
  const share = await member.evaluate(async ({ api, pageId }) => {
    const r = await fetch(`${api}/share-links`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ resource: { type: "page", id: pageId }, capability: "edit", expiresInSeconds: null }),
    });
    return `/share/${(await r.json()).id}`;
  }, { api: API, pageId });

  const guest = await (await browser.newContext()).newPage();
  await guest.goto(share);
  await guest.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(600);

  // arriving: nobody has asked for vim, so the toggle's ON default must not make a guest's prose
  // monospace on sight
  const onArrival = await readFace(guest);
  expect(onArrival, `a guest who has not touched anything :: ${onArrival}`).toContain("Inter");

  await guest.getByTestId("edit-toggle").click();
  await sleep(500);
  expect(await readFace(guest), "editing without vim is still proportional").toContain("Inter");

  await guest.getByTestId("vim-toggle").click();
  await faceBecomes(guest, "UDEV");
  expect(await readFace(guest), "a guest's vim brings the grid — device-local, no profile involved")
    .toContain("UDEV");

  // and the collab surface survived the change: the marker is CSS, and a face swap must not be the thing
  // that costs a guest their connection to the room (the core of this product is anonymous co-editing)
  await guest.click("[data-pane=preview] .cm-content");
  await guest.keyboard.press("i");
  await guest.keyboard.type("GUESTSTILLCONNECTED");
  await guest.keyboard.press("Escape");
  await expect(guest.locator("[data-pane=preview] .cm-content"))
    .toContainText("GUESTSTILLCONNECTED", { timeout: 10_000 });
});
