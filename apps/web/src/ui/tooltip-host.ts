import { TOOLTIP_DELAY_MS } from "../components/ui/tooltip";

// #530: the DELEGATED tooltip for DOM built outside React — CodeMirror widgets, macro chrome, and the
// other ~34 `setAttribute("title", …)` sites. Those cannot be wrapped in <Tooltip>, but they must not
// grow a SECOND tooltip look either, so this shares the primitive's delay (TOOLTIP_DELAY_MS) and paints
// the same surface tokens (.wks-tip in tokens.css).
//
// Contract for callers: set `el.dataset.tip = "text"` instead of `el.title = "text"`. One document-level
// listener pair handles every one of them (no per-element listeners to leak), and the bubble is a single
// reused node appended to <body> — NOT to the editor DOM, so CodeMirror never reconciles it away (the
// cm-floating-ui lesson) and it cannot be clipped by the widget's own overflow.
//
// It deliberately does nothing on coarse pointers: a hover tooltip on touch either never shows or shows
// on tap and eats the tap (ADR-159 / #406). Touch users get the aria-label / visible text instead.

let bubble: HTMLDivElement | null = null;
let showTimer: number | null = null;
let current: HTMLElement | null = null;
let installed = false;

function ensureBubble(): HTMLDivElement {
  if (bubble?.isConnected) return bubble;
  const el = document.createElement("div");
  el.className = "wks-tip";
  el.setAttribute("role", "tooltip");
  el.hidden = true;
  document.body.appendChild(el);
  bubble = el;
  return el;
}

function place(target: HTMLElement, tip: HTMLDivElement): void {
  const r = target.getBoundingClientRect();
  tip.hidden = false;
  // measure after showing (a hidden element has no box), then clamp into the viewport
  const t = tip.getBoundingClientRect();
  const gap = 6;
  let top = r.top - t.height - gap;
  if (top < 4) top = r.bottom + gap; // flip below when there is no room above
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - t.width - 4));
  tip.style.top = `${Math.round(top)}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function hide(): void {
  if (showTimer != null) { window.clearTimeout(showTimer); showTimer = null; }
  current = null;
  if (bubble) { bubble.hidden = true; bubble.textContent = ""; }
}

function scheduleFor(target: HTMLElement): void {
  const text = target.dataset.tip;
  if (!text) return;
  if (current === target) return;
  hide();
  current = target;
  showTimer = window.setTimeout(() => {
    // the pointer may have left during the delay
    if (current !== target || !target.isConnected) return hide();
    const tip = ensureBubble();
    tip.textContent = text;
    place(target, tip);
  }, TOOLTIP_DELAY_MS);
}

const tipTargetFrom = (node: EventTarget | null): HTMLElement | null =>
  (node as HTMLElement | null)?.closest?.("[data-tip]") as HTMLElement | null;

// Idempotent: one install per document (HMR self-accepts + reloads, so no double install in dev).
export function installTooltipHost(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  // Coarse pointers (touch): no hover tooltips at all — see the note above.
  if (window.matchMedia?.("(pointer: coarse)").matches) return;

  document.addEventListener("pointerover", (e) => {
    const t = tipTargetFrom(e.target);
    if (t) scheduleFor(t); else if (current && !current.contains(e.target as Node)) hide();
  }, true);
  document.addEventListener("pointerout", (e) => {
    const t = tipTargetFrom(e.target);
    if (t && t === current) hide();
  }, true);
  // Keyboard parity — the native title never did this.
  document.addEventListener("focusin", (e) => {
    const t = tipTargetFrom(e.target);
    if (t) scheduleFor(t);
  }, true);
  document.addEventListener("focusout", () => hide(), true);
  // Anything that moves the anchor invalidates the placement; hiding is the honest cheap answer.
  document.addEventListener("scroll", () => hide(), true);
  window.addEventListener("resize", () => hide());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
  document.addEventListener("pointerdown", () => hide(), true);
}
