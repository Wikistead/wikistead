import { useEffect, useRef, useState } from "react";
import type { Heading } from "../editor/headings";

// #313: land the page on the heading named by the URL hash (#<slug>) once the surface's headings
// are known. Content loads async (published fetch / collab sync / public render), so this watches
// the headings list and fires ONCE when the slug first appears; an unknown slug never scrolls
// (top of page — never an error). `jump` is the surface's existing band-aware TOC jump, so the
// heading lands below the frosted title band exactly like a TOC click (#304 geometry).
// A hash WE wrote (replaceHashWith, below) must never re-trigger a landing: after a TOC click sets
// #<slug>, a later doc edit re-fires the headings effect, which would otherwise yank the viewport
// back to that heading mid-typing. Module-level (one window/URL).
let selfWrittenSlug: string | null = null;

export function useHeadingHashLanding(headings: Heading[], jump: (from: number) => void): void {
  const handled = useRef<string | null>(null);
  // Navigating from /p/x to /p/x#slug is a FRAGMENT navigation — no reload, no react-router
  // transition, so no effect re-run. Listen for hashchange (a real user navigation — replaceState
  // never fires it) to re-arm and land on the new slug.
  const [hashTick, setHashTick] = useState(0);
  useEffect(() => {
    const onHash = () => { handled.current = null; selfWrittenSlug = null; setHashTick((t) => t + 1); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    let slug = "";
    try { slug = decodeURIComponent(window.location.hash.slice(1)); } catch { return; /* malformed % */ }
    if (!slug) { handled.current = null; return; } // hash cleared (in-app nav) → re-arm
    if (handled.current === slug || selfWrittenSlug === slug) return;
    const h = headings.find((x) => x.slug === slug);
    if (!h) return;
    handled.current = slug;
    // Next frame: the band height var (--wks-band-h) is published by a ResizeObserver on mount —
    // give layout a beat so the jump's scroll clearance sees the real band. NO cleanup-cancel:
    // `headings` gets a fresh array identity on every editor update, so the effect re-runs (and
    // skips via `handled`) immediately after scheduling — cancelling here would swallow the one
    // scheduled jump. The jump is safe post-unmount (ref'd, null-guarded by the callers).
    requestAnimationFrame(() => jump(h.from));
  }, [headings, jump, hashTick]);
}

// Reflect a TOC/anchor jump in the URL (shareable) without polluting history: hash-only
// replaceState, PRESERVING history.state (react-router keeps its own state there).
export function replaceHashWith(slug: string): void {
  selfWrittenSlug = slug;
  window.history.replaceState(window.history.state, "", `#${encodeURIComponent(slug)}`);
}
