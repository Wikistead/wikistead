import { test, expect } from "@playwright/test";
import { openDemo, enterEdit, sleep, API } from "../helpers";

// #374 ② / ADR-149 §1: macros must render on the GUEST edit-share reader. mermaid is pure-client (no server, no
// pageId), so it proves the live-preview extension is ACTIVE on the guest surface (the "all macros stay raw"
// hypothesis is disproven). The pageId-dependent SERVER-render macros (plantuml/Kroki, transclude) are wired by
// passing pageId to the guest Editor mount (the /pages/:id/plantuml/render route is already `guest: 'view'`),
// but the e2e stack has no Kroki so plantuml always degrades to source here → those stay needs-human-check.
//
// #989: plain NODE-side fetch, not page.evaluate — called before `member` has navigated anywhere (still
// `about:blank`, an opaque origin the app's now same-origin-only CORS always refuses regardless of policy),
// and Node's own fetch is not subject to browser CORS at all (see helpers.ts's createScratchPage).
async function newPage(title: string): Promise<string> {
  const r = await fetch(`${API}/spaces/demo_space/pages`, {
    method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" }, body: JSON.stringify({ title }),
  });
  return ((await r.json()) as { id: string }).id;
}
async function editShareUrl(pageId: string): Promise<string> {
  const r = await fetch(`${API}/share-links`, {
    method: "POST", headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ resource: { type: "page", id: pageId }, capability: "edit", expiresInSeconds: null }),
  });
  const id = ((await r.json()) as { id: string }).id;
  return `/share/${id}`;
}

test("#374: an edit-share guest renders macros (mermaid diagram) on the guest surface", async ({ browser }) => {
  const member = await (await browser.newContext()).newPage();
  await openDemo(member);
  const pageId = await newPage("guest-macro-374");
  await member.goto(`/p/${pageId}`);
  await member.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(300);
  await enterEdit(member);
  await member.click("[data-pane=preview] .cm-content");
  await member.keyboard.insertText("top\n```mermaid\nflowchart TD\n  A --> B\n```\nbelow\n");
  await sleep(2800); // collab debounce so the edit guest loads this draft

  const url = await editShareUrl(pageId);
  const guest = await (await browser.newContext()).newPage();
  await guest.goto(url);
  await guest.waitForSelector("[data-pane=preview] .cm-content", { timeout: 10000 });
  await sleep(800);
  await enterEdit(guest);
  await sleep(500);
  await guest.getByText("below").click(); // caret off the block → the diagram renders (not raw)

  // The mermaid diagram renders as a real <svg> on the GUEST surface → the live-preview macro rendering IS active
  // for an edit-share guest (not "everything stays raw"). Server-render macros are wired via pageId (ADR-149 §1).
  await expect(guest.locator("[data-pane=preview] [data-testid=macro-mermaid] svg").first()).toBeVisible({ timeout: 15000 });
  expect(await guest.locator("[data-pane=preview] .cm-content").innerText()).not.toContain("flowchart TD"); // rendered, not raw
});
