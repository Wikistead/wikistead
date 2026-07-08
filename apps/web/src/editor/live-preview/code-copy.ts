// #227 a copy button for code blocks rendered OUTSIDE CodeMirror (the public reader's
// renderMarkdownToDom output, which is a plain <pre><code>). The CM editor has its own copy button in the
// fence header (decorations.ts FenceHeaderWidget); this is the parity for the shared DOM renderer. XSS-safe:
// the icons are trusted constant SVGs (no user input) and the clipboard only ever receives code.textContent.

// Lucide copy / check glyphs (same constants as the fence header, #198).
const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';
const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

// Add a copy button to every top-level `<pre>` (with a `<code>`) under `root` that doesn't already have one.
// The button copies the code block's text (textContent — never markup). `label` is the accessible name.
export function addCodeCopyButtons(root: HTMLElement, label: string): void {
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    if (!code || pre.querySelector(".cm-lp-code-copy")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-lp-code-copy";
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", () => {
      void navigator.clipboard?.writeText(code.textContent ?? "").then(() => {
        btn.classList.add("cm-lp-code-copied");
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => { btn.classList.remove("cm-lp-code-copied"); btn.innerHTML = COPY_ICON; }, 1400);
      }).catch(() => { /* clipboard denied (insecure ctx / permission) — no-op */ });
    });
    (pre as HTMLElement).style.position = "relative";
    pre.appendChild(btn);
  }
}
