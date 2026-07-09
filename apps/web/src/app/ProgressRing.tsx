// #290 / ADR-114 (increment A): a small React progress ring for the title band, showing the whole page's
// GFM-checkbox progress. Display-only; reuses the shared ring track/arc/label CSS (callout-icons.css). Its
// own wrapper class flows inline (the .cm-lp-todo-ring class is absolutely positioned for the macro header).
// Renders nothing when there are no tasks (0/0 → no ring, per ADR-114).
export function ProgressRing({ done, total }: { done: number; total: number }) {
  if (total <= 0) return null;
  const frac = Math.max(0, Math.min(1, done / total));
  const size = 15;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <span className="wks-page-ring" data-testid="page-task-ring" data-done={done} data-total={total} title={`${done}/${total}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} className="cm-lp-todo-ring-track" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          className="cm-lp-todo-ring-arc"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - frac)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="cm-lp-todo-ring-label">{done}/{total}</span>
    </span>
  );
}
