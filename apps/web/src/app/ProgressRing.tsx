// #290 / ADR-114 (increment A): a small React progress ring for the title band + sidebar rows, showing GFM
// checkbox progress. Display-only; reuses the shared ring track/arc/label CSS (callout-icons.css).
// Renders nothing when there are no tasks (0/0 → no ring, per ADR-114).
// #290grey track + ORANGE arc; the arc turns GREEN at 100% — colour is the completion cue
// (thecentre-checkmark + its transition tracking are gone, user re-ruling).
export function ProgressRing({ done, total, compact = false }: { done: number; total: number; compact?: boolean }) {
  const frac = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
  const complete = total > 0 && done >= total;

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
          className={`cm-lp-todo-ring-arc${complete ? " cm-lp-todo-ring-complete" : ""}`}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          transform={`rotate(-90 ${c} ${c})`}
        />
      </svg>
      {!compact && <span className="cm-lp-todo-ring-label">{done}/{total}</span>}
    </span>
  );
}
