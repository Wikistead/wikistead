import type { Page } from "@playwright/test";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const API = "http://dev.localhost:4010";

export async function openDemo(page: Page) {
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.waitForSelector("[data-testid=sidebar]");
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
