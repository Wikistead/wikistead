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
