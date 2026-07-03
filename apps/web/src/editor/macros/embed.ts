import type { DirectiveMacro } from "./registry";
import { embedHtmlRender } from "@wikistead/macro-render"; // #85: export htmlRender shared (degrades to a link)

// :::embed — embed an external resource by URL (the body is the URL). #108 / ADR-071 (comment 551)
// external embeds are CLIENT-DIRECT sandboxed iframes for operator-allowlisted hosts only (never a
// server proxy → no SSRF surface for this path; never an arbitrary iframe → no tracking/XSS). The
// MACRO never fetches or reads the allowlist (host-API is {theme} only, ADR-024 trust boundary); the
// host (live-preview MacroWidget) checks the URL host against the injected tenant allowlist and swaps
// in a sandboxed iframe, or DEGRADES to a plain link (Open formats — never a broken/blocked embed).
// Server HTML export also degrades to a link (the sanitizer forbids <iframe>).
export const embedMacro: DirectiveMacro = {
  kind: "directive",
  name: "embed",
  exportFidelity: "degrade", // an external iframe can't round-trip to static HTML → a link is the faithful degrade
  revealOnCursor: true, // edit the URL by placing the caret inside (like :::transclude)
  liveRender: (body) => {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-embed";
    el.setAttribute("data-testid", "macro-embed");
    el.textContent = body.trim() ? "…" : "Empty embed — add a URL"; // host swaps in the iframe / link
    return el;
  },
  htmlRender: embedHtmlRender, // server/static: a link (no iframe in exported HTML)
  slash: { labelKey: "palette.embed", keywords: "embed external iframe youtube video url 埋め込み 外部 リンク", insert: ":::embed\n\n:::", caret: 9 },
};

// Is `url` an https URL whose host is on the operator allowlist? Host match is exact OR a subdomain
// (allowlist "youtube.com" matches "www.youtube.com" but NOT "evilyoutube.com"). Non-https and
// unparseable URLs are never allowlisted. Pure — the single source of truth for the iframe/degrade
// decision, unit-tested independently of the DOM.
export function isAllowlistedEmbed(url: string, allowlist: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return allowlist.some((raw) => {
    const h = raw.trim().toLowerCase().replace(/^\.+/, "");
    return h !== "" && (host === h || host.endsWith("." + h));
  });
}

// Build the embed DOM for a resolved URL: a sandboxed iframe when the host is allowlisted, otherwise
// a degrade link (never a broken/blocked frame). Kept here (not in the macro's liveRender) because
// the allowlist is host-injected — the macro itself can't see it (narrow host-API).
export function buildEmbedElement(url: string, allowlist: readonly string[]): HTMLElement {
  const trimmed = url.trim();
  if (isAllowlistedEmbed(trimmed, allowlist)) {
    const iframe = document.createElement("iframe");
    iframe.className = "cm-lp-embed-frame";
    iframe.src = trimmed;
    iframe.setAttribute("data-testid", "macro-embed-frame");
    // Minimal-but-functional sandbox for a TRUSTED allowlisted host (comment 551: "allow-scripts
    // "). No allow-top-navigation / allow-modals / allow-downloads. Privacy: no-referrer so the
    // embedding page URL isn't leaked to the external host (comment 551 privacy concern).
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-presentation");
    iframe.setAttribute("referrerpolicy", "no-referrer");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("allowfullscreen", "");
    return iframe;
  }
  // Degrade: a plain link (Open formats). nofollow + noreferrer keeps it inert and private.
  const a = document.createElement("a");
  a.className = "cm-lp-embed-degrade";
  a.setAttribute("data-testid", "macro-embed-degrade");
  a.href = trimmed;
  a.textContent = trimmed || "(empty embed)";
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  return a;
}
