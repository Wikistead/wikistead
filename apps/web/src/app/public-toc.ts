import { useEffect, useRef, useState } from "react";
import type { Heading } from "../editor/headings";
import { slugify } from "../editor/headings";

// #227 comment 1078 ②: a table-of-contents for the PUBLIC reader view. The public body is rendered OUTSIDE
// CodeMirror (renderMarkdownToDom), so the editor's heading extension isn't available — collect the headings
// straight from the rendered DOM instead. Each heading gets a synthetic `from` = its DOM order index (the
// Toc component only needs a stable key + a jump token), a GitHub-style slug as its element id (anchor), and
// a data-toc-from marker so onJump can find it. Display-only: no doc, no offsets, no new data surface.

// The nearest scrollable ancestor (the public content self-scrolls inside AppShell's overflow-hidden main on
// the space route; on the single-page route the window scrolls). We listen on BOTH so scroll-sync works in
// either layout; getBoundingClientRect is viewport-relative, so the math is the same regardless.
function scrollParent(el: HTMLElement | null): HTMLElement | Window {
  for (let n = el?.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === "auto" || oy === "scroll") return n;
  }
  return window;
}

export function usePublicToc(bodyEl: HTMLElement | null, ready: boolean): {
  headings: Heading[];
  activeFrom: number | null;
  jump: (from: number) => void;
  // #227 a scroll subscription so the narrow-screen OVERLAY TOC can reuse the member's Toc wiring
  // (the overlay shows while scrolling, driven by this). Stable identity (a ref), so Toc's effect is stable.
  subscribeScroll: (fn: () => void) => () => void;
} {
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [activeFrom, setActiveFrom] = useState<number | null>(null);
  const elsRef = useRef<HTMLElement[]>([]);
  const subsRef = useRef<Set<() => void>>(new Set());
  const subscribeScroll = useRef((fn: () => void) => {
    subsRef.current.add(fn);
    return () => { subsRef.current.delete(fn); };
  }).current;

  useEffect(() => {
    if (!bodyEl || !ready) { setHeadings([]); setActiveFrom(null); elsRef.current = []; return; }
    const els = Array.from(bodyEl.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6"));
    elsRef.current = els;
    const seen = new Set<string>();
    const hs: Heading[] = els.map((el, i) => {
      const text = (el.textContent ?? "").trim();
      const slug = slugify(text || `heading-${i + 1}`, seen);
      el.id = slug; // anchor for direct linking + scrollIntoView
      el.dataset.tocFrom = String(i);
      return { level: Number(el.tagName[1]), text, from: i, slug };
    });
    setHeadings(hs);

    const sc = scrollParent(bodyEl);
    // #304 (2): scroll metrics of whichever ancestor scrolls (element or the window), for the bottom clamp.
    const metrics = () => (sc === window
      ? { top: window.scrollY, ch: window.innerHeight, sh: document.documentElement.scrollHeight }
      : { top: (sc as HTMLElement).scrollTop, ch: (sc as HTMLElement).clientHeight, sh: (sc as HTMLElement).scrollHeight });
    // The ACTIVE heading is the last one whose top has scrolled above the frosted title band (so the section
    // you're reading is highlighted). Recomputed on scroll + resize.
    const recompute = () => {
      // #304 (1): threshold = the band's REAL height (--wks-band-h, published on the outer wrapper and
      // inherited here), not a fixed 120px — matches the heading scroll-margin so a jumped-to heading lights.
      const bandH = parseFloat(getComputedStyle(bodyEl).getPropertyValue("--wks-band-h")) || 0;
      const thr = bandH + 8;
      let active: number | null = els.length ? 0 : null;
      for (const el of els) {
        if (el.getBoundingClientRect().top <= thr) active = Number(el.dataset.tocFrom);
        else break;
      }
      // #304 (2): at the very bottom, a final section shorter than the viewport never reaches the threshold,
      // so clamp the last heading active when scrolled to the end.
      const m = metrics();
      if (els.length && m.top + m.ch >= m.sh - 2) active = Number(els[els.length - 1].dataset.tocFrom);
      setActiveFrom(active);
    };
    recompute();
    // #227 on scroll, recompute the active heading AND notify overlay subscribers (member parity —
    // the narrow overlay fades in while scrolling). resize only needs the recompute.
    const onScroll = () => { recompute(); subsRef.current.forEach((fn) => fn()); };
    sc.addEventListener("scroll", onScroll, { passive: true } as AddEventListenerOptions);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", recompute);
    return () => {
      sc.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", recompute);
    };
  }, [bodyEl, ready]);

  const jump = (from: number) => {
    elsRef.current[from]?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveFrom(from); // #304 (3): light the jumped-to heading immediately (scroll recompute converges to it)
  };
  return { headings, activeFrom, jump, subscribeScroll };
}
