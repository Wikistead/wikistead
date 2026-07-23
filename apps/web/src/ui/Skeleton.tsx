import { useEffect, useState } from "react";

// #457: loading placeholders. Before this, a page that was still fetching looked exactly like a page
// with nothing in it — the reader could not tell "empty" from "not here yet". A skeleton says
// "content is coming"; the empty state says "there is none".
//
// Design constraints (ticket): existing tokens only (no new colour system), the motion convention
// (surface-only, no layout animation), a static fallback under prefers-reduced-motion, and no layout
// shift when the real content replaces it.

// One neutral bar. `w` is any Tailwind width class so callers can shape a realistic paragraph.
export function Skeleton({ w = "w-full", h = "h-4", className = "" }: { w?: string; h?: string; className?: string }) {
  return (
    <div
      className={`${w} ${h} rounded bg-panel-2 animate-pulse motion-reduce:animate-none ${className}`}
      data-testid="skeleton-bar"
      aria-hidden="true"
    />
  );
}

// A page-body shaped skeleton: a heading, then paragraphs of ragged line lengths. Sized off the same
// type scale as rendered prose so the real content lands where the bars were.
export function ProseSkeleton({ testid = "prose-skeleton" }: { testid?: string }) {
  return (
    <div className="flex flex-col gap-3" data-testid={testid} role="status" aria-busy="true">
      <Skeleton w="w-1/2" h="h-7" className="mb-1" />
      <Skeleton />
      <Skeleton w="w-11/12" />
      <Skeleton w="w-4/5" />
      <Skeleton w="w-1/3" h="h-5" className="mt-4 mb-1" />
      <Skeleton w="w-full" />
      <Skeleton w="w-10/12" />
    </div>
  );
}

// #492: a sidebar page-tree shaped skeleton — a handful of indented rows (icon + label bar) that read as
// "the tree is loading", distinct from the "No pages yet" empty state. The ragged indents echo a nested
// tree without implying a specific shape.
export function SidebarTreeSkeleton({ testid = "sidebar-skeleton" }: { testid?: string }) {
  const rows: { pad: string; w: string }[] = [
    { pad: "pl-2", w: "w-3/4" },
    { pad: "pl-2", w: "w-2/3" },
    { pad: "pl-5", w: "w-1/2" },
    { pad: "pl-5", w: "w-3/5" },
    { pad: "pl-2", w: "w-4/5" },
    { pad: "pl-8", w: "w-1/2" },
  ];
  return (
    <div className="flex flex-col gap-1.5 p-2" data-testid={testid} role="status" aria-busy="true">
      {rows.map((r, i) => (
        <div key={i} className={`flex items-center gap-1.5 ${r.pad}`}>
          <Skeleton w="w-4" h="h-4" className="flex-none" />
          <Skeleton w={r.w} h="h-4" />
        </div>
      ))}
    </div>
  );
}

// #457a list-row shaped skeleton for the right panels (comments / history / attachments) and
// the search result list — a few ragged rows that read as "entries are coming", distinct from each
// panel's own empty wording. Same bar primitive, same tokens, same reduced-motion fallback.
export function PanelRowsSkeleton({ rows = 4, testid = "panel-skeleton" }: { rows?: number; testid?: string }) {
  const widths = ["w-3/4", "w-11/12", "w-3/5", "w-5/6", "w-2/3", "w-4/5"];
  return (
    <div className="flex flex-col gap-2.5 py-1" data-testid={testid} role="status" aria-busy="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <Skeleton w="w-4" h="h-4" className="flex-none rounded-full" />
          <Skeleton w={widths[i % widths.length]} h="h-4" />
        </div>
      ))}
    </div>
  );
}

// The anti-flicker gate: a load that resolves in 50ms must NOT flash a skeleton (worse than showing
// nothing). Returns true only once `active` has been continuously true for `delayMs`.
export function useDelayedFlag(active: boolean, delayMs = 150): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) { setShown(false); return; }
    const id = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(id);
  }, [active, delayMs]);
  return shown;
}
