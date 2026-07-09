import { headingAnchorUrl, HEADING_LINK_ICON } from "./heading-anchor";

// #313: the hover 🔗 for headings rendered OUTSIDE CodeMirror (the public reader's
// renderMarkdownToDom output). Parity with the CM widget in heading-anchor.ts; relies on the ids
// usePublicToc already assigns (el.id = slug), so it must run AFTER that hook. XSS-safe: the icon
// is a trusted constant SVG and the clipboard only ever receives the anchor URL built from el.id.
export function addHeadingAnchorButtons(root: HTMLElement, label: string, onCopied?: () => void): void {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]"))) {
    if (el.querySelector(".wks-heading-anchor")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "wks-heading-anchor";
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.setAttribute("data-testid", "heading-anchor-copy");
    btn.dataset.slug = el.id;
    btn.innerHTML = HEADING_LINK_ICON;
    btn.addEventListener("click", () => {
      void navigator.clipboard?.writeText(headingAnchorUrl(el.id))
        .then(() => onCopied?.())
        .catch(() => { /* clipboard denied (insecure ctx / permission) — no-op */ });
    });
    el.appendChild(btn);
  }
}
