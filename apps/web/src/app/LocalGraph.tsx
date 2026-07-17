import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { useTheme } from "./ThemeProvider";
import type { LocalGraphResult } from "../data/queries";

// #394 / ADR-147: the local link-graph canvas (sigma.js + graphology — the user-ruled renderer). PURE
// display: the server already view-filtered both endpoints of every edge, so this never filters, counts,
// or fetches — it draws exactly what it was given. Nodes are pages (click = navigate), edges are colored
// AND sized by kind (c 04:15 return item 4: embed = accent + heavy, link = muted + thin; the legend below
// the canvas names them), hover dims everything outside the hovered neighbourhood WITHOUT hiding labels
// (item 1: labels are always rendered — labelRenderedSizeThreshold 0, and the reducer only dims). Layout
// is a LIVE ForceAtlas2 worker (item 3: nodes animate to their positions, then the layout stops) with
// compaction settings (item 2: lower scalingRatio + higher gravity than inferSettings' defaults, so small
// graphs don't fly apart). Colors come from the live CSS tokens at mount so the canvas follows light/dark
// (rebuilt on theme change).
export function LocalGraphCanvas({
  data,
  onOpenPage,
  className,
}: {
  data: LocalGraphResult;
  onOpenPage: (pageId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  // The handler lives in a ref so pointer wiring survives re-renders without rebuilding the sigma instance.
  const openRef = useRef(onOpenPage);
  openRef.current = onOpenPage;

  useEffect(() => {
    const el = ref.current;
    if (!el || data.nodes.length === 0) return;
    const css = getComputedStyle(el);
    const color = (v: string, fb: string) => css.getPropertyValue(v).trim() || fb;
    const accent = color("--link", "#0969da");
    const fg = color("--fg", "#1f2328");
    const fgDim = color("--fg-dim", "#656d76");
    const faint = color("--border", "#d0d7de");

    // multi+directed: the same page pair can carry both a `link` and an `embed` edge.
    const graph = new Graph({ multi: true, type: "directed" });
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    data.nodes.forEach((n, i) => {
      const isCenter = n.id === data.center;
      const angle = (2 * Math.PI * i) / Math.max(1, data.nodes.length);
      graph.addNode(n.id, {
        label: n.title || "…",
        // circular seed (center pinned at the origin); the live force layout below relaxes it.
        // #394 (2): a WIDE seed (radius 6, not 1) — the compacted settle sits near the origin,
        // so a unit-circle seed produced sub-pixel displacement and the animation was invisible.
        // Spread → contract is the visible motion.
        x: isCenter ? 0 : Math.cos(angle) * 6,
        y: isCenter ? 0 : Math.sin(angle) * 6,
        size: isCenter ? 9 : Math.min(4 + (degree.get(n.id) ?? 0) * 0.75, 8),
        color: isCenter ? accent : fgDim,
      });
    });
    data.edges.forEach((e, i) => {
      if (graph.hasNode(e.from) && graph.hasNode(e.to)) {
        graph.addEdgeWithKey(`e${i}`, e.from, e.to, {
          // c 04:15 item 4: the edge KIND is color-coded (theme tokens), not just stroke weight.
          color: e.type === "embed" ? accent : faint,
          size: e.type === "embed" ? 2.5 : 1,
        });
      }
    });

    const sigma = new Sigma(graph, el, {
      renderEdgeLabels: false,
      labelColor: { color: fg },
      labelSize: 11,
      labelDensity: 1,
      // c 04:15 item 1: page titles are ALWAYS visible — no node-size / zoom threshold hides them.
      labelRenderedSizeThreshold: 0,
      minCameraRatio: 0.3,
      maxCameraRatio: 3,
    });
    // c 04:15 items 2+3, REWORKED per the live layout is a MAIN-THREAD rAF loop over the sync
    // ForceAtlas2 iterator — the `graphology-layout-forceatlas2/worker` blob worker silently failed to
    // start on the real device (no message ever arrived, nothing threw), leaving the seed frozen; a
    // worker can't be trusted to animate. Each frame runs a couple of iterations and refreshes sigma,
    // so the spread seed visibly contracts to the compacted settle (scalingRatio down / gravity up vs
    // inferSettings, c2112-2) and stops after a bounded window; unmount cancels the loop.
    let raf = 0;
    if (graph.order > 2) {
      const inferred = forceAtlas2.inferSettings(graph);
      const settings = {
        ...inferred,
        adjustSizes: true,
        scalingRatio: Math.max(0.5, (inferred.scalingRatio ?? 10) / 5),
        gravity: Math.max(1, (inferred.gravity ?? 1) * 5),
        slowDown: 5, // damped motion — animate, don't jitter
      };
      let frames = 0;
      const step = () => {
        forceAtlas2.assign(graph, { iterations: 2, settings });
        sigma.refresh();
        if (++frames < 150) raf = requestAnimationFrame(step); // ~2.5s settle window
      };
      raf = requestAnimationFrame(step);
    }
    // e2e seam (the false-green lesson): the movement pin samples real display coordinates
    // across frames — same spirit as the editor's __lp* diagnostics. Display-only, never read by app code.
    (el as HTMLElement & { __wksSigma?: Sigma }).__wksSigma = sigma;
    // Hover: keep the hovered node + its neighbourhood, DIM the rest. The label stays (c 04:15 item 1 —
    // dimming alone reads fine; hiding labels made the graph unreadable while hovering).
    let hovered: string | null = null;
    sigma.setSetting("nodeReducer", (node, attrs) =>
      !hovered || node === hovered || graph.areNeighbors(node, hovered)
        ? attrs
        : { ...attrs, color: faint },
    );
    sigma.setSetting("edgeReducer", (edge, attrs) =>
      !hovered || graph.hasExtremity(edge, hovered) ? attrs : { ...attrs, hidden: true },
    );
    sigma.on("enterNode", ({ node }) => {
      hovered = node;
      el.style.cursor = "pointer";
      sigma.refresh();
    });
    sigma.on("leaveNode", () => {
      hovered = null;
      el.style.cursor = "";
      sigma.refresh();
    });
    sigma.on("clickNode", ({ node }) => openRef.current(node));
    return () => {
      cancelAnimationFrame(raf);
      sigma.kill();
    };
  }, [data, theme]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={ref} className={className} data-testid="local-graph-canvas" />
      {/* c 04:15 item 4: the edge-kind legend (line color → relation type). Display-only. */}
      <div className="flex items-center gap-3 pt-1 text-[11px] text-fg-dim" data-testid="local-graph-legend">
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-[2px] w-4 rounded" style={{ background: "var(--border)" }} />
          {t("related.graphLegendLink")}
        </span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden className="inline-block h-[3px] w-4 rounded" style={{ background: "var(--link)" }} />
          {t("related.graphLegendEmbed")}
        </span>
      </div>
    </div>
  );
}
