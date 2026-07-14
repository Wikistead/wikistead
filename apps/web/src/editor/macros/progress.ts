// #290 / ADR-114: count GFM task items in a Markdown block and render a display-only progress ring.
// Pure counting + DOM-at-render; used by the :::todo open-line header ring. Display-only — it never mutates
// the doc, so the single-Y.Text invariant is untouched.

// A GFM task item: a bullet (-,*,+) or ordered (1./1)) marker + `[ ]` / `[x]` / `[X]`. Nesting counts the
// same as top-level (each checkbox is one task), matching ADR-019's ordinal scan.
const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;

export function countTasks(md: string): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const line of md.split("\n")) {
    const m = TASK_RE.exec(line);
    if (!m) continue;
    total++;
    if (m[1] !== " ") done++;
  }
  return { done, total };
}

// A display-only SVG progress ring + a `done/total` label. Returns null when there are no tasks
// (0/0 → NO ring, per ADR-114). Tokenized (callout-icons.css): grey track, ORANGE progress arc
// (--callout-warning), and the arc turns GREEN (--callout-tip) at 100% — colour IS the completion cue
// (the centre-checkmark is gone, user re-ruling). Trusted — no user input in the SVG.
export function renderProgressRing(done: number, total: number): HTMLElement | null {
  if (total <= 0) return null;
  const frac = Math.max(0, Math.min(1, done / total));
  const complete = done >= total;
  const size = 15;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const NS = "http://www.w3.org/2000/svg";

  const wrap = document.createElement("span");
  wrap.className = "cm-lp-todo-ring";
  wrap.setAttribute("data-testid", "todo-ring");
  wrap.setAttribute("data-done", String(done));
  wrap.setAttribute("data-total", String(total));
  wrap.title = `${done}/${total}`;

  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  const mk = (cls: string) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", String(size / 2));
    c.setAttribute("cy", String(size / 2));
    c.setAttribute("r", String(r));
    c.setAttribute("class", cls);
    return c;
  };
  const track = mk("cm-lp-todo-ring-track");
  const arc = mk(`cm-lp-todo-ring-arc${complete ? " cm-lp-todo-ring-complete" : ""}`);
  arc.setAttribute("stroke-dasharray", String(circ));
  arc.setAttribute("stroke-dashoffset", String(circ * (1 - frac))); // fill CW from the top
  arc.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  svg.append(track, arc);

  const label = document.createElement("span");
  label.className = "cm-lp-todo-ring-label";
  label.textContent = `${done}/${total}`;

  wrap.append(svg, label);
  return wrap;
}

// #361: update an EXISTING ring DOM in place instead of rebuilding it, so the arc's `<circle>` is RETAINED and
// the shared `transition: stroke-dashoffset` (callout-icons.css) fires — the ring animates on a task toggle.
// Rebuilding (a fresh SVG) has no from→to and never animates. Returns false if `wrap` is not a ring we can
// update (the caller then rebuilds). Geometry constants MUST match renderProgressRing above.
export function updateProgressRing(wrap: HTMLElement, done: number, total: number): boolean {
  if (total <= 0) return false; // 0 tasks renders nothing — let the caller drop the widget
  const arc = wrap.querySelector<SVGCircleElement>(".cm-lp-todo-ring-arc");
  const label = wrap.querySelector<HTMLElement>(".cm-lp-todo-ring-label");
  if (!arc || !label) return false;
  const frac = Math.max(0, Math.min(1, done / total));
  const complete = done >= total;
  const size = 15;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  arc.setAttribute("stroke-dashoffset", String(circ * (1 - frac))); // the animated attribute (transition fires)
  arc.classList.toggle("cm-lp-todo-ring-complete", complete);
  label.textContent = `${done}/${total}`;
  wrap.setAttribute("data-done", String(done));
  wrap.setAttribute("data-total", String(total));
  wrap.title = `${done}/${total}`;
  return true;
}
