import type { DirectiveMacro } from "./registry";
import { embedHtmlRender } from "@wikistead/macro-render"; // #85: export htmlRender shared (degrades to a link)
import { macroPlaceholder, showPlaceholder } from "./placeholder"; // #600: one template for every "cannot show it" state
import { safeHref } from "./md-render"; // #319 one shared scheme check for the degrade href (no js:/data:)
import i18n from "../../i18n";

// :::embed-external — embed an external resource by URL (the body is the URL). #108 / ADR-071 (551)
// #205 renamed `:::embed` → `:::embed-external` to namespace with `:::embed-page` (embed-<what>).
// external embeds are CLIENT-DIRECT sandboxed iframes for operator-allowlisted hosts only (never a
// server proxy → no SSRF surface for this path; never an arbitrary iframe → no tracking/XSS). The
// MACRO never fetches or reads the allowlist (host-API is {theme} only, ADR-024 trust boundary); the
// host (live-preview MacroWidget) checks the URL host against the injected tenant allowlist and swaps
// in a sandboxed iframe, or DEGRADES to a plain link (Open formats — never a broken/blocked embed).
// Server HTML export also degrades to a link (the sanitizer forbids <iframe>).
export const embedMacro: DirectiveMacro = {
  kind: "directive",
  // #600: the palette entry reads "Embed external content" (an action). In a sentence the name is
  // "embed", which is the word the empty-state copy has used since #174.
  nameKey: "macro.name.embed",
  name: "embed-external",
  exportFidelity: "degrade", // an external iframe can't round-trip to static HTML → a link is the faithful degrade
  revealOnCursor: true, // paired with atomSelectable below (the URL is edited via the modal, not caret-in raw)
  // #366: embed-external is a MODAL-completed leaf atom (openEmbedExternalPrompt on insert / Ctrl+Enter to retarget — #548 removed the ⇆ button),
  // so — exactly like embed-page — an empty caret resting on it SELECTS the atom (card + ring, no raw reveal) and
  // the URL is re-edited via the EmbedUrlModal (Ctrl+Enter), never hand-typed in the block. Raw editing stays
  // reachable via Source mode (Open formats). See ADR-024 addendum (atomSelectable)/#366.
  atomSelectable: true,
  liveRender: (body, ctx) => {
    // #550: ONE resolution path (the #450 slice-5c shape). The host used to spot this macro BY NAME in
    // the top-level MacroWidget only, so a copy nested in tabs/columns/details reached the DOM sink,
    // nobody swapped the placeholder, and "…" sat there forever on the read AND edit surfaces. Now the
    // macro asks for a host slot; the host answers with the allowlist-checked iframe / degrade link on
    // every surface that installs the seam. The allowlist itself never crosses the boundary (ADR-024).
    const url = body.trim();
    if (url) {
      const slot = ctx?.hostSlot?.({ kind: "embed", url });
      if (slot) return slot;
    }
    // No host on this surface (export, hover card) — or an empty body: the placeholder, as before.
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-embed-external";
    el.setAttribute("data-testid", "macro-embed-external");
    // #600: `…` said nothing — not even which macro was sitting there. A URL with no host to build the
    // iframe is "this surface does not show it"; no URL at all is the empty state.
    //
    // The URL is deliberately NOT appended. It is one clause too many for a sentence every other
    // placeholder shares, a native `title` is refused here (#530), and a tooltip is the thing this
    // ticket declined to add. Nothing is lost: the URL is in the source a keystroke away, and the
    // export path renders a real link rather than this placeholder.
    showPlaceholder(el, embedMacro, url ? "no-host" : "empty-url");
    return el;
  },
  htmlRender: embedHtmlRender, // server/static: a link (no iframe in exported HTML)
  slash: { labelKey: "palette.embed", keywords: "embed external iframe youtube video url 埋め込み 外部 リンク", insert: ":::embed-external\n\n:::", caret: 18 },
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
  // #108 (comment 643): NEVER iframe the app's own origin. A same-origin iframe with
  // allow-scripts + allow-same-origin escapes the sandbox and reaches the parent editor DOM/tokens, so
  // even if an admin adds the app host to the allowlist it must degrade to a link. hostname parsing
  // (URL) already strips a `user@` userinfo bypass ("youtube.com@evil.com" → hostname "evil.com").
  if (typeof window !== "undefined" && window.location && u.origin === window.location.origin) return false;
  const host = u.hostname.toLowerCase();
  return allowlist.some((raw) => {
    const h = raw.trim().toLowerCase().replace(/^\.+/, "");
    return h !== "" && (host === h || host.endsWith("." + h));
  });
}

// #908: some hosts refuse framing entirely (X-Frame-Options/CSP) on all but one path, so allowlisting
// the host to enable that ONE embeddable path also allowlists every other page on it — which built a
// blank iframe the browser draws inside its OWN chrome (the product never gets to say anything), read
// by a reporting user as "the product is broken". This is a HOST+PATH check, evaluated ONLY when the
// URL would otherwise become an iframe (see buildEmbedElement): a host that ISN'T allowlisted already
// degrades to a link — the existing, correct, content-preserving behaviour export/print (both call
// this with an empty allowlist, apps/web/src/data/exportBrowser.ts / app/PrintSurface.tsx) depend on,
// and guidance replacing that link would be a regression (#207's content-loss shape, reintroduced).
interface UnembeddableRule {
  test: (u: URL) => boolean;
  key: string; // i18n key, apps/web/src/i18n/locales/{en,ja}.json
}
// Any of google's own ccTLD storefronts (google.com, google.co.jp, google.co.uk, google.de, …) or its
// maps.* subdomain, with or without `www.`.
const GOOGLE_HOST = /^(?:www\.|maps\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/i;
const UNEMBEDDABLE_RULES: readonly UnembeddableRule[] = [
  {
    // Google Maps sends X-Frame-Options: SAMEORIGIN on every page except the one its own
    // Share → "Embed a map" panel produces (…/maps/embed?pb=…). Covers the share-link shortener
    // (maps.app.goo.gl and the bare goo.gl/maps/… form, any path) and the Maps site itself, on any of
    // Google's ccTLDs and with or without a trailing slash after /maps.
    test: (u) =>
      u.hostname === "maps.app.goo.gl" ||
      (/^(?:www\.)?goo\.gl$/i.test(u.hostname) && u.pathname.startsWith("/maps")) ||
      (GOOGLE_HOST.test(u.hostname) && /^\/maps(?:\/|$)/.test(u.pathname) && !u.pathname.startsWith("/maps/embed")),
    key: "macro.embedUnembeddableGoogleMaps",
  },
];

/** The i18n key for a known-unembeddable URL's guidance sentence, or null if `url` matches no known-bad shape. */
export function unembeddableGuidance(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const rule = UNEMBEDDABLE_RULES.find((r) => r.test(u));
  return rule ? rule.key : null;
}

// Build the embed DOM for a resolved URL: a sandboxed iframe when the host is allowlisted, otherwise
// a degrade link (never a broken/blocked frame). Kept here (not in the macro's liveRender) because
// the allowlist is host-injected — the macro itself can't see it (narrow host-API).
export function buildEmbedElement(url: string, allowlist: readonly string[]): HTMLElement {
  const trimmed = url.trim();
  if (isAllowlistedEmbed(trimmed, allowlist)) {
    // #908: the allowlist alone can't tell "this path frames fine" from "this path is on the same
    // host but refuses" — check that BEFORE building the iframe, only here, so a host that was never
    // allowlisted keeps degrading to a link exactly as before (export/print's contract).
    const guidanceKey = unembeddableGuidance(trimmed);
    if (guidanceKey) {
      const div = document.createElement("div");
      div.className = "cm-lp-macro cm-lp-embed-unembeddable";
      div.setAttribute("data-testid", "macro-embed-unembeddable");
      div.textContent = i18n.t(guidanceKey);
      return div;
    }
    const iframe = document.createElement("iframe");
    iframe.className = "cm-lp-embed-frame";
    iframe.src = trimmed;
    iframe.setAttribute("data-testid", "macro-embed-frame");
    // Minimal-but-functional sandbox for a TRUSTED allowlisted host (comment 551: keep grants such as
    // allow-scripts to a minimum). No allow-top-navigation / allow-modals / allow-downloads. Privacy
    // no-referrer so the embedding page URL isn't leaked to the external host (comment 551 privacy concern).
    // #108 (comment 643) defence-in-depth: allow-same-origin ONLY for a cross-origin frame — same-origin
    // is already rejected above, but never combine allow-scripts + allow-same-origin on our own origin
    // (that pair disables the sandbox), so drop it if the src ever resolves same-origin.
    let sameOrigin = false;
    try { sameOrigin = typeof window !== "undefined" && !!window.location && new URL(trimmed).origin === window.location.origin; } catch { /* unparseable → treat as cross-origin (still sandboxed) */ }
    iframe.setAttribute("sandbox", sameOrigin ? "allow-scripts allow-popups allow-presentation" : "allow-scripts allow-same-origin allow-popups allow-presentation");
    // #108 bounce: `no-referrer` suppresses the Referer entirely, which triggers YouTube error 153
    // ("video player configuration error") — YouTube's required-minimum-functionality doc says an
    // embedded player must receive a Referer and forbids a Referrer-Policy that strips it, recommending
    // `strict-origin-when-cross-origin` (the de-facto fix — Pimcore/react-player/fancyapps all use it).
    // Privacy is still protected: strict-origin-when-cross-origin sends ONLY the origin (host) cross-
    // origin — never the path/query/page content — and only to operator-allowlisted hosts, so the
    // comment-551 "don't leak the embedding page URL" intent holds for path/content.
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("allow", "fullscreen"); // YouTube/Vimeo expect the fullscreen permission policy
    iframe.setAttribute("allowfullscreen", "");
    return iframe;
  }
  // Degrade to a plain link (Open formats) — but ONLY for a safe scheme. #319 (anon-XSS gate): the
  // body is arbitrary user text, and this DOM becomes a LIVE `<a>` (unlike renderMarkdownToDom's textContent
  // degrade), so an un-checked `javascript:`/`data:`/`vbscript:`/`file:` body would be a one-click stored XSS
  // once this surface is the anonymous public reader (#319) — and is already a latent hole on the member
  // edit surface. Route the href through the SAME shared `safeHref` scheme check every other link uses; an
  // unsafe scheme degrades further to inert plain TEXT (never a clickable dangerous href).
  const href = safeHref(trimmed);
  if (!href) {
    const span = document.createElement("span");
    span.className = "cm-lp-embed-degrade";
    span.setAttribute("data-testid", "macro-embed-degrade");
    span.textContent = trimmed || "(empty embed)";
    return span;
  }
  const a = document.createElement("a");
  a.className = "cm-lp-embed-degrade";
  a.setAttribute("data-testid", "macro-embed-degrade");
  a.href = href;
  a.textContent = trimmed || "(empty embed)"; // show the original text; only the href is sanitized
  a.target = "_blank";
  a.rel = "noopener noreferrer nofollow";
  return a;
}
