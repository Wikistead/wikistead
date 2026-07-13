import { asMacroSource, type FenceMacro, type MacroContext } from "./registry";
import { mermaidHtmlRender } from "@wikistead/macro-render"; // #85: export htmlRender is shared, single source
import { mountSourceEditor } from "./source-editor"; // #243 / ADR-111 C3: CM6 mini-editor source pane

// The first macro: ```mermaid renders a diagram. It proves the registry pipeline
// (register -> liveRender -> fold -> Markdown round-trip) on the code-fence path,
// which needs NO parser. mermaid is MIT (license:check gate cleared).

let seq = 0;
const nextId = () => `wks-mermaid-${seq++}`;

// #352: LRU cache of rendered SVGs, keyed on (theme + code). CM6 virtualizes — it DESTROYS a block widget that
// scrolls out of the viewport — so without a cache a re-entered ```mermaid re-runs the full mermaid.render
// (parse + layout + SVG gen) from scratch every time, the scroll-jank + async-burst the ticket measured. A
// cache hit re-injects the SAME SVG synchronously (no async render, no height re-settle). The SVG's baked id is
// reused verbatim, which the anti-test pins as the cache-hit signal (a body/theme edit changes the key → a
// fresh render → a new id). Bounded so a huge document can't grow it without limit. Only successful renders
// laid out at a REAL width are cached (a degenerate width-0 render — a hidden tab, #174 — is never stored).
const SVG_CACHE_MAX = 60;
const svgCache = new Map<string, string>();
function svgCacheGet(key: string): string | undefined {
  const v = svgCache.get(key);
  if (v !== undefined) { svgCache.delete(key); svgCache.set(key, v); } // LRU touch (move to most-recent)
  return v;
}
function svgCacheSet(key: string, svg: string): void {
  svgCache.delete(key);
  svgCache.set(key, svg);
  while (svgCache.size > SVG_CACHE_MAX) { const oldest = svgCache.keys().next().value; if (oldest === undefined) break; svgCache.delete(oldest); }
}

// Lazy-loaded so mermaid (large) stays out of the main bundle — imported on first
// render of a ```mermaid block. `securityLevel: "strict"` makes mermaid sanitize the
// SVG it produces (it bundles DOMPurify), so user-authored diagram text cannot inject
// script even though we assign the result via innerHTML below.
const mermaidTheme = (theme: MacroContext["theme"]): "dark" | "default" => (theme === "dark" ? "dark" : "default");
// suppressErrorRendering (#191): on a syntax error mermaid otherwise injects a "bomb" error diagram into the
// DOM (body), which accumulates on every re-render/keystroke. Suppress it — we render our own in-macro error
// message in the catch below.
const mermaidConfig = (theme: MacroContext["theme"]) =>
  ({ startOnLoad: false, securityLevel: "strict" as const, suppressErrorRendering: true, theme: mermaidTheme(theme) });
let mermaidP: Promise<typeof import("mermaid")["default"]> | null = null;
let initedTheme: "dark" | "default" | null = null;
// #360: mermaid is a singleton whose theme is set by initialize. It was initialized ONCE at first load, so a
// mid-session light/dark switch left every diagram rendered in the ORIGINAL theme (the widget rebuilds with the
// new ctx.theme — MacroWidget.eq keys on theme, #200 — and the #352 SVG cache key includes the theme, so it
// re-renders; but mermaid.render still used the stale initialized theme). RE-initialize whenever the requested
// theme differs from the last one applied — theme is page-global, so all diagrams share it at any instant.
function loadMermaid(theme: MacroContext["theme"]) {
  if (!mermaidP) {
    mermaidP = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize(mermaidConfig(theme));
      initedTheme = mermaidTheme(theme);
      return mermaid;
    });
  }
  return mermaidP.then((mermaid) => {
    const want = mermaidTheme(theme);
    if (initedTheme !== want) {
      mermaid.initialize(mermaidConfig(theme)); // follow a mid-session theme switch
      initedTheme = want;
    }
    return mermaid;
  });
}

// #282 (3): `mermaid.render(id, code)` with NO 3rd arg makes mermaid 11 append its text-measuring
// node in-flow at document.body — a ~150px node with no hidden style. html/body/#root have no overflow
// clamp, so for the render's duration the WINDOW overflows and its scrollbar flashes ("a scrollbar
// further right, appearing and vanishing"). Fix: give each render its OWN off-flow sandbox as the 3rd
// arg (svgContainingElement), so the temp node lands there, not in the body flow. position:fixed keeps
// it out of the document flow (visibility:hidden + a REAL width so text still measures — display:none
// would collapse the layout mermaid needs, the #174 hidden-tab class). Per-render (never a shared
// singleton: mermaid does innerHTML= and would wipe a concurrent render's in-progress node — the page
// lays out many diagrams at once). Removing the sandbox in finally also disposes mermaid's temp node,
// so the old getElementById("d"+id) cleanup is folded in here.
async function renderMermaidOffscreen(
  mermaid: Awaited<ReturnType<typeof loadMermaid>>,
  id: string,
  code: string,
  width: number,
): Promise<{ svg: string }> {
  const sandbox = document.createElement("div");
  const w = Math.max(1, Math.round(width) || document.body.clientWidth || 800);
  sandbox.style.cssText = `position:fixed;left:-10000px;top:0;width:${w}px;visibility:hidden;pointer-events:none`;
  document.body.appendChild(sandbox);
  try {
    return await mermaid.render(id, code, sandbox);
  } finally {
    sandbox.remove(); // disposes mermaid's temp measuring node with it
  }
}

export const mermaidMacro: FenceMacro = {
  kind: "fence",
  lang: "mermaid",
  exportFidelity: "preserve", // declarative text body → round-trips verbatim
  foldable: false, // #174 / ADR-087: no collapse button on a rendered diagram (the reviewer flagged it)
  summary: () => "Mermaid diagram",
  slash: { labelKey: "palette.mermaid", keywords: "diagram flowchart graph chart mermaid", insert: "```mermaid\n\n```", caret: 11 },
  liveRender(body, ctx) {
    const el = document.createElement("div");
    el.className = "cm-lp-macro cm-lp-mermaid";
    el.setAttribute("data-testid", "macro-mermaid");
    const code = body.trim();
    if (!code) return el;
    // #174 point 1: render the SVG into a dedicated CHILD, not el.innerHTML. When this macro is nested in a
    // columns/tabs container, the WYSIWYG hover-✎ is appended to `el` (the tagged slot); setting
    // el.innerHTML async would WIPE that pencil (the info callout kept its pencil only because its render is
    // synchronous). Replacing just the `fig` child leaves el's other children (the pencil) intact.
    const fig = document.createElement("div");
    fig.className = "cm-lp-mermaid-fig";
    el.appendChild(fig);
    // #352: cache key is (theme + code). A hit re-injects the cached SVG synchronously — no mermaid.render, no
    // async paint, no height re-settle on scroll re-entry (the measured jank). The id baked into the cached SVG
    // is reused (the anti-test's cache-hit signal).
    const cacheKey = `${ctx.theme ?? "light"}\x00${code}`;
    // #174 (1): mermaid sizes a diagram by MEASURING text via layout. Inside a display:none tab
    // panel that measures 0, so the SVG comes out degenerate (a tiny sliver). Paint once now; then re-paint
    // ONCE the element first gains a real width — a ResizeObserver fires when the tab activates (display:none
    // → block gives it a layout box). Only the `fig` child is replaced, so a nested WYSIWYG pencil appended to
    // `el` survives (per the note above). Guarded (painting / paintedWidth) so a normally-visible diagram that
    // rendered correctly on the first paint doesn't re-render churn.
    let paintedWidth = 0; // the width the current SVG was laid out at (0 = never at a real width)
    let painting = false;
    const paint = () => {
      if (painting) return;
      painting = true;
      const id = nextId(); // fresh id per paint so a re-paint can't collide with the previous svg's id (#191)
      void loadMermaid(ctx.theme).then(async (mermaid) => {
        try {
          // #282: measure in an off-flow sandbox at the element's real width, so the window never overflows.
          const { svg } = await renderMermaidOffscreen(mermaid, id, code, el.clientWidth);
          fig.innerHTML = svg; // sanitized by mermaid (securityLevel: strict)
          paintedWidth = el.clientWidth;
          if (paintedWidth > 0) svgCacheSet(cacheKey, svg); // #352: cache a real-width render for scroll re-entry
        } catch {
          el.classList.add("cm-lp-macro-error");
          fig.textContent = "Invalid mermaid diagram"; // in-macro only (suppressErrorRendering stops the body bomb)
        } finally {
          painting = false; // #282: the sandbox (with mermaid's temp node) is disposed inside renderMermaidOffscreen
        }
      });
    };
    // #352: on a cache hit (a diagram re-entering the viewport, or an identical one already rendered this
    // session), inject the cached SVG SYNCHRONOUSLY and skip the async render — mark it painted so the
    // ResizeObserver below won't re-paint it. A cache MISS falls through to the async paint (and stores the
    // result). paintedWidth is set nonzero so the RO's "gained a real width" re-paint doesn't re-run it.
    const cached = svgCacheGet(cacheKey);
    if (cached) {
      fig.innerHTML = cached;
      paintedWidth = el.clientWidth || 1;
    } else {
      paint();
    }
    const ro = new ResizeObserver(() => { if (paintedWidth === 0 && el.clientWidth > 0) paint(); });
    ro.observe(el);
    return el;
  },
  // #174 / ADR-087: the unified inline editUI — the first first-party consumer of the editUI framework.
  // Reached via the single edit button (or Ctrl+Enter). A split panel: a source textarea + a LIVE
  // preview that re-renders the diagram as you type (the value reveal-on-cursor never gave). Host-API is
  // { theme } + save only (ADR-024) — the macro uses its OWN mermaid dep for the preview, never the host.
  // Save granularity: on `change` (commit/blur), NOT per keystroke — an immediate per-keystroke save
  // re-runs the doc → the host re-mounts this widget → the textarea would reset mid-typing. Input drives
  // the local preview; the Y.Text write lands on blur (still merges via Y.Text). ADR-087 inline contract.
  editUI: {
    present: "inline",
    mount(container, source, ctx, save, editEnv) {
      const wrap = document.createElement("div");
      wrap.className = "cm-lp-mermaid-edit";
      // #243 / ADR-111 C3 (slice 1): the source pane is a CM6 mini-editor (undo/redo, wrapping, code face)
      // instead of a bare textarea. It commits to the single Y.Text via `save` on BLUR only (never a live
      // binding). vim is C3 slice 2 (needs the host CM6 seam to reuse the outer vim). See source-editor.ts.
      const src = document.createElement("div");
      src.className = "cm-lp-mermaid-edit-src";
      const preview = document.createElement("div");
      preview.className = "cm-lp-mermaid cm-lp-mermaid-edit-preview";
      preview.setAttribute("data-testid", "mermaid-edit-preview");
      let gen = 0; // guards against a stale async render landing after a newer edit
      let debounce: ReturnType<typeof setTimeout> | undefined;
      const applyRender = (code: string) => {
        const trimmed = code.trim();
        if (!trimmed) { preview.style.minHeight = ""; preview.textContent = ""; return; }
        const myId = nextId();
        const mine = ++gen;
        // #282: while the async re-render is in flight, HOLD the pane's current height as min-height so it
        // doesn't collapse (a mid-typing invalid diagram would otherwise shrink to a 1-line error and bounce
        // back — the "right half flickers" + the doc height crossing the viewport → the scrollbar flashing).
        const held = preview.offsetHeight;
        if (held > 0) preview.style.minHeight = `${held}px`;
        void loadMermaid(ctx.theme).then(async (mermaid) => {
          try {
            // #282: sandbox the measuring node off-flow so a per-keystroke render never flashes the window bar.
            const { svg } = await renderMermaidOffscreen(mermaid, myId, trimmed, preview.clientWidth);
            if (mine === gen) { preview.innerHTML = svg; preview.style.minHeight = ""; } // release once the new size is in
          } catch {
            if (mine === gen) preview.textContent = "Invalid mermaid diagram"; // keep min-height → no collapse
          }
        }).catch(() => { /* mermaid failed to load (offline/test env) — the preview just stays empty */ });
      };
      // #282: debounce so a per-keystroke burst of async renders (each flashing the preview) collapses into
      // ONE render after the user pauses — cuts the flash frequency and the height-vibration.
      const renderPreview = (code: string) => {
        if (debounce != null) clearTimeout(debounce);
        debounce = setTimeout(() => applyRender(code), 150);
      };
      wrap.append(src, preview);
      container.appendChild(wrap);
      const editor = mountSourceEditor({
        parent: src,
        doc: source,
        dark: ctx.theme === "dark",
        vim: editEnv?.vim, // #243 C3 slice 2: follow the outer editor's vim setting
        testid: "mermaid-edit-src",
        onInput: (v) => renderPreview(v), // local live preview, no doc write
        onCommit: (v) => save(asMacroSource(v)), // commit to Y.Text on blur (offset-invariant replaceSource)
      });
      applyRender(source); // initial render is immediate (no debounce) so the preview shows on mount
      const focus = setTimeout(() => editor.focus(), 0);
      return {
        handlesEscape: () => editor.inVimInsert(), // #243 C3 slice 2b: first Escape = vim insert→normal, not exit
        destroy() { clearTimeout(focus); if (debounce != null) clearTimeout(debounce); gen++; editor.destroy(); wrap.remove(); },
      };
    },
  },
  // M3 wires HTML export server-side. mermaid renders in the browser, so the static
  // form is the source in a <pre class="mermaid"> (a mermaid-enabled HTML viewer
  // renders it; any other shows the code). XSS-safe: the body is escaped.
  htmlRender: mermaidHtmlRender,
};
