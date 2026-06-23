import type { Page } from "@playwright/test";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function openDemo(page: Page) {
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await page.waitForSelector("[data-testid=sidebar]");
  await sleep(800);
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
