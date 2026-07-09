import { useEffect, useRef, useState } from "react";

// #290 / ADR-114 (increment A): a small React progress ring for the title band + sidebar rows, showing GFM
// checkbox progress. Display-only; reuses the shared ring track/arc/label/check CSS (callout-icons.css).
// Renders nothing when there are no tasks (0/0 → no ring, per ADR-114).
// #290 (1): at 100% a checkmark ✓ appears in the ring centre; it animates in ONLY on the completion
// transition (…<1 → done===total), not on mount-at-100% or a re-render, tracked with a ref.
export function ProgressRing({ done, total, compact = false }: { done: number; total: number; compact?: boolean }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const complete = total > 0 && done >= total;
  const wasComplete = useRef(complete);
  const [justCompleted, setJustCompleted] = useState(false);
  useEffect(() => {
    const prev = wasComplete.current;
    wasComplete.current = complete;
    if (!prev && complete) {
      setJustCompleted(true);
      const id = setTimeout(() => setJustCompleted(false), 600);
      return () => clearTimeout(id);
    }
  }, [complete]);

  if (total <= 0) return null;
  const size = compact ? 12 : 15;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const c = size / 2;
  return (
    <span className="wks-page-ring" data-testid="page-task-ring" data-done={done} data-total={total} title={`${done}/${total}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={c} cy={c} r={r} className="cm-lp-todo-ring-track" />
        <circle
          cx={c}
          cy={c}
          r={r}
          className="cm-lp-todo-ring-arc"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          transform={`rotate(-90 ${c} ${c})`}
        />
        {complete && (
          <path
            d={`M${c - 2.8} ${c} L${c - 0.6} ${c + 2.2} L${c + 3} ${c - 2.4}`}
            className={`cm-lp-todo-ring-check${justCompleted ? " cm-lp-todo-ring-check-in" : ""}`}
          />
        )}
      </svg>
      {!compact && <span className="cm-lp-todo-ring-label">{done}/{total}</span>}
    </span>
  );
}
