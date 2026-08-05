import { TOOLTIP_DELAY_MS } from "../components/ui/tooltip";
import { HINT_CLOSE_GRACE_MS } from "./hint-panel";

// #530: the DELEGATED tooltip for DOM built outside React — CodeMirror widgets, macro chrome, and the
// other ~34 `setAttribute("title", …)` sites. Those cannot be wrapped in <Tooltip>, but they must not
// grow a SECOND tooltip look either, so this shares the primitive's delay (TOOLTIP_DELAY_MS) and paints
// the same surface tokens (.wks-tip in tokens.css).
//
// Two ways to declare one:
//   - `el.dataset.tip = "text"` — always show this text.
//   - `el.dataset.tipIfTruncated = "text"` — show it ONLY while the element is actually clipped.
// The second exists because callers were deciding that themselves in `onMouseEnter`, which is too early:
// entering a sidebar row REVEALS its hover buttons, and those take the width that pushes the label into
// an ellipsis. Measured before the buttons appear, the label still fits, so the tooltip was suppressed on
// exactly the rows that needed it (#530). The host re-measures when the delay elapses — after the
// layout settles — so the decision is made against what the user is actually looking at.
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
let hideTimer: number | null = null;
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
  if (hideTimer != null) { window.clearTimeout(hideTimer); hideTimer = null; }
  current = null;
  if (bubble) { bubble.hidden = true; bubble.textContent = ""; }
}

// #630: the shared close grace. Leaving a target used to hide the bubble on the same tick, while the
// group-roles panels waited 160ms — and that wait is what lets a pointer cross the few pixels between an
// anchor and the thing it opened. Handing the same grace to this host makes the two behave alike, and
// gives a delegated tooltip the same forgiveness for a pointer that clips a boundary on its way.
// Anything that INVALIDATES the bubble rather than merely leaving it (scroll, resize, Escape, a pointer
// press) still calls `hide()` directly — those are not "the pointer wandered off", they are "what this
// was pointing at has moved".
function hideAfterGrace(): void {
  if (hideTimer != null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => { hideTimer = null; hide(); }, HINT_CLOSE_GRACE_MS);
}

// `scrollWidth` exceeds `clientWidth` exactly when the content does not fit — i.e. when the ellipsis is
// showing. Rounded because sub-pixel layout can leave a fractional difference on a label that DOES fit.
const isTruncated = (el: HTMLElement): boolean => el.scrollWidth - el.clientWidth > 1;

// #530 (review rejection, measured): a conditional tooltip used to be declared ON the element it measures —
// but that element is exactly the one whose width changes on hover. On a tree row, the hover buttons appear
// and the name span SHRINKS out from under the cursor; the pointer is then over the row, not the name, and
// the leave rule below hides the tooltip. So the row could be hovered and never show its own name — and
// only when the cursor happened to sit past the shrunken width, which is why it looked intermittent.
// `data-tip-measure` splits the two roles: the ANCHOR (which the pointer must stay within, so the row) and
// the MEASURED element (the clipped label inside it). Absent the attribute, the target measures itself.
const measuredEl = (target: HTMLElement): HTMLElement => {
  const sel = target.dataset.tipMeasure;
  if (!sel) return target;
  return (target.querySelector(sel) as HTMLElement | null) ?? target;
};

function textFor(target: HTMLElement): string | undefined {
  const conditional = target.dataset.tipIfTruncated;
  if (conditional) return isTruncated(measuredEl(target)) ? conditional : undefined;
  return target.dataset.tip || undefined;
}

function scheduleFor(target: HTMLElement): void {
  if (hideTimer != null) { window.clearTimeout(hideTimer); hideTimer = null; }
  // Only a cheap presence check here — whether a CONDITIONAL tooltip actually applies is decided when the
  // delay elapses, because the layout it depends on changes as a result of this very hover.
  if (!target.dataset.tip && !target.dataset.tipIfTruncated) return;
  if (current === target) return;
  hide();
  current = target;
  showTimer = window.setTimeout(() => {
    // the pointer may have left during the delay
    if (current !== target || !target.isConnected) return hide();
    const text = textFor(target); // re-measured now: the hover buttons are in place
    if (!text) return hide();
    const tip = ensureBubble();
    tip.textContent = text;
    place(target, tip);
  }, TOOLTIP_DELAY_MS);
}

const tipTargetFrom = (node: EventTarget | null): HTMLElement | null =>
  (node as HTMLElement | null)?.closest?.("[data-tip], [data-tip-if-truncated]") as HTMLElement | null;

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
    if (t && t === current) hideAfterGrace();
  }, true);
  // Keyboard parity — the native title never did this.
  document.addEventListener("focusin", (e) => {
    const t = tipTargetFrom(e.target);
    if (t) scheduleFor(t);
  }, true);
  document.addEventListener("focusout", () => hideAfterGrace(), true);
  // Anything that moves the anchor invalidates the placement; hiding is the honest cheap answer.
  document.addEventListener("scroll", () => hide(), true);
  window.addEventListener("resize", () => hide());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hide(); }, true);
  document.addEventListener("pointerdown", () => hide(), true);
}
