import type { Page } from "@playwright/test";
// @ts-expect-error — repo-root JS helper, no types
import { e2ePorts } from "../../scripts/stack-offset.mjs";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// #484 slice 2: the app origins, derived from WKS_STACK_OFFSET (offset 0 = the original literals).
// Every spec MUST import these instead of hardcoding dev.localhost:4010 / :5180 / :5181 — a hardcoded
// port would hit the wrong (or another session's) stack once isolation is enabled. dev.localhost (not
// localhost) so the server resolves tenant slug "dev".
const P = e2ePorts();
export const API = `http://dev.localhost:${P.server}`; // server REST base (direct, bypasses the web proxy)
export const WEB = `http://dev.localhost:${P.web}`; // dev-token web origin (baseURL)
export const WEB_PORT = P.web; // dev-token web port, for other hosts (e.g. `acme.localhost:${WEB_PORT}`)
export const WEB_REAL_PORT = P.webReal; // real-auth web port, for `${slug}.localhost:${WEB_REAL_PORT}`

// #354: publish a page and WAIT until its published body actually contains `expectSubstring`. The publish flush
// (collab Valkey req/ack) has a timeout and, under parallel-load, can snapshot a stale/empty ydoc so
// published_md comes out empty — making "type → sleep → publish → assert the view" specs flaky. Polling the
// real published body (re-publishing until it lands) replaces the non-deterministic fixed sleep, so a slow
// flush just costs another poll instead of a false red. Throws if the content never lands within the timeout.
export async function publishAndWait(page: Page, id: string, expectSubstring: string, timeoutMs = 15000): Promise<void> {
  await page.evaluate(
    async ({ api, id, expect, timeoutMs }) => {
      const H = { Authorization: "Bearer dev-token" };
      const deadline = Date.now() + timeoutMs;
      let last = "";
      while (Date.now() < deadline) {
        await fetch(`${api}/pages/${id}/publish`, { method: "POST", headers: H });
        const r = await fetch(`${api}/pages/${id}/published`, { headers: H });
        if (r.ok) {
          last = ((await r.json())?.publishedMd as string | null) ?? "";
          if (last.includes(expect)) return;
        }
        await new Promise((res) => setTimeout(res, 400));
      }
      throw new Error(`publishAndWait: /published never contained "${expect}" within ${timeoutMs}ms (last: "${last.slice(0, 80)}")`);
    },
    { api: API, id, expect: expectSubstring, timeoutMs },
  );
}

export async function openDemo(page: Page) {
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  // #406 S1: below md the docked sidebar is a closed drawer — the toggle is the always-present marker.
  await page.waitForSelector("[data-testid=sidebar], [data-testid=sidebar-toggle]");
  await sleep(800);
}

// Create a REAL throwaway page in demo_space and return its id. Editor specs that need
// an isolated doc (no shared-demo presence ghosts) use this instead of navigating to a
// made-up /p/<id>: a non-existent page is no longer an editable phantom (every page
// belongs to a space — the page#space premise), so tests must edit real pages. The
// caller's page must already be at the app origin (so the cross-origin POST is allowed).
export async function createScratchPage(page: Page, title = "Scratch"): Promise<string> {
  return page.evaluate(async ({ api, title }) => {
    const r = await fetch(`${api}/spaces/demo_space/pages`, {
      method: "POST",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return ((await r.json()) as { id: string }).id;
  }, { api: API, title });
}

// #253 / ADR-113: flip the tenant PARENT SWITCH (tenant_settings.public_enabled) via the admin API. The
// whole anonymous public surface 404s while this is OFF (default), so any spec that expects public rendering
// must turn it ON first. dev-token is a tenant admin in dev mode. The caller's page must be at the app origin.
export async function setPublicSurface(page: Page, enabled: boolean): Promise<void> {
  await page.evaluate(async ({ api, enabled }) => {
    const r = await fetch(`${api}/admin/public-settings`, {
      method: "PUT",
      headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!r.ok) throw new Error(`public-settings PUT failed: ${r.status}`);
  }, { api: API, enabled });
}

// Convenience for single-client editor specs: load the app, create a scratch page, open
// it, and wait for the surface. Returns the page id.
export async function openScratch(page: Page, title = "Scratch"): Promise<string> {
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const id = await createScratchPage(page, title);
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  return id;
}

// The editor opens rendered (read-only). Edit reveals the single live-preview surface
// (Step I — split / separate source pane removed). Requires an edit-capable user (the
// dev-token bypass qualifies).
export async function enterEdit(page: Page) {
  await page.click("[data-testid=edit-toggle]");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(150);
}
// Back-compat alias: there is no split anymore — entering edit IS the single surface.
export const enterSplit = enterEdit;

export async function resetDoc(page: Page) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await sleep(250);
}

export const paneText = (page: Page, pane: "source" | "preview") =>
  page.$eval(`[data-pane=${pane}] .cm-content`, (el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".cm-ySelectionCaret").forEach((n) => n.remove());
    return clone.innerText.replace(/[​⁠]/g, "");
  });

// First character after the remote caret in a pane (display order). Offset-
// invariant: which logical char a collaborator sits before, regardless of which
// markdown syntax this pane hides.
export function charAfterCaret() {
  return (paneSel: string) => {
    const content = document.querySelector(paneSel + " .cm-content");
    if (!content) return { found: false } as { found: boolean; char?: string | null };
    const caret = content.querySelector(".cm-ySelectionCaret");
    if (!caret) return { found: false };
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_ALL);
    let passed = false;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node === caret) { passed = true; continue; }
      if (caret.contains(node)) continue;
      if (passed && node.nodeType === 3) {
        const t = (node.nodeValue ?? "").replace(/[⁠​]/g, "");
        if (t.length) return { found: true, char: t[0] };
      }
    }
    return { found: true, char: null };
  };
}
