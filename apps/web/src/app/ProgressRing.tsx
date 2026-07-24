// #290 / ADR-114 (increment A): a small React progress ring for the title band + sidebar rows, showing GFM
// checkbox progress. Display-only; reuses the shared ring track/arc/label CSS (callout-icons.css).
// Renders nothing when there are no tasks (0/0 → no ring, per ADR-114).
// #290 grey track + ORANGE arc; the arc turns GREEN at 100% — colour is the completion cue
// (the centre-checkmark + its transition tracking are gone, user re-ruling).
import { useLayoutEffect, useRef } from "react";

// #361 point 3: the SIDEBAR ring lives in a react-arborist virtualized row that REMOUNTS on every
// pages refetch, so the arc is always a fresh element and a plain CSS transition can never fire (the
// probe: the marked <circle> is isConnected=false after a toggle). Instead of fighting the row
// recycling (high regression risk on the #284 sidebar pins), remember the LAST fraction per animKey in a
// module map: a mount whose value CHANGED paints the previous offset first and flips to the new one next
// frame, so the SHARED arc transition (callout-icons.css, 200ms) animates prev→new exactly like the
// in-editor ring — while a value-unchanged remount (row recycling, refetch re-render) never animates.
const lastFrac = new Map<string, number>();

export function ProgressRing({ done, total, compact = false, animKey }: { done: number; total: number; compact?: boolean; animKey?: string }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const complete = total > 0 && done >= total;

  const size = compact ? 12 : 15;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const c = size / 2;

  // Key includes the surface's geometry (compact) so the band and sidebar rings of the SAME page track
  // their own last value — the other surface's first mount must not replay an animation.
  const key = animKey != null ? `${animKey}:${compact ? "c" : "f"}` : null;
  const arcRef = useRef<SVGCircleElement>(null);
  // Mount-only: if this element replaced one whose value differed, start at the OLD offset and flip to
  // the new one a frame later — the CSS transition does the motion. The offset is driven via the style
  // prop below, so later in-place re-renders keep animating through the same property (no attr/style split).
  useLayoutEffect(() => {
    const arc = arcRef.current;
    const prev = key != null ? lastFrac.get(key) : undefined;
    if (!arc || prev === undefined || prev === frac) return;
    arc.style.strokeDashoffset = String(circ * (1 - prev));
    const raf = requestAnimationFrame(() => { arc.style.strokeDashoffset = String(circ * (1 - frac)); });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Track the latest value for the NEXT mount (also on in-place updates, which the style prop animates).
  // Deferred to AFTER paint (rAF): a react-arborist refetch can render the new value on the OLD row
  // instance and REPLACE the row in the same frame — that unpainted intermediate render must not clobber
  // the baseline, or the replacement mounts with prev === frac and the replay never fires (the probe-
  // observed miss). The unmount cleanup cancels the pending write, so only PAINTED values become the
  // baseline. Only real values: a transient 0/0 render must not cause a phantom 0→frac pulse either.
  useLayoutEffect(() => {
    if (key == null || total <= 0) return;
    const raf = requestAnimationFrame(() => lastFrac.set(key, frac));
    return () => cancelAnimationFrame(raf);
  }, [key, frac, total]);

  if (total <= 0) return null;
  return (
    <span className="wks-page-ring" data-testid="page-task-ring" data-done={done} data-total={total} data-tip={`${done}/${total}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={c} cy={c} r={r} className="cm-lp-todo-ring-track" />
        <circle
          ref={arcRef}
          cx={c}
          cy={c}
          r={r}
          className={`cm-lp-todo-ring-arc${complete ? " cm-lp-todo-ring-complete" : ""}`}
          strokeDasharray={circ}
          style={{ strokeDashoffset: circ * (1 - frac) }}
          transform={`rotate(-90 ${c} ${c})`}
        />
      </svg>
      {!compact && <span className="cm-lp-todo-ring-label">{done}/{total}</span>}
    </span>
  );
}
