import { useEffect, useRef } from "react";
import Graph from "graphology";
import Sigma from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { useTheme } from "./ThemeProvider";
import type { LocalGraphResult } from "../data/queries";

// #394 / ADR-147: the local link-graph canvas (sigma.js + graphology — the user-ruled renderer). PURE
// display: the server already view-filtered both endpoints of every edge, so this never filters, counts,
// or fetches — it draws exactly what it was given. Nodes are pages (click = navigate), edge kind varies
// the stroke (embed heavier than link), hover dims everything outside the hovered neighbourhood. Colors
// come from the live CSS tokens at mount so the canvas follows light/dark (rebuilt on theme change).
export function LocalGraphCanvas({
  data,
  onOpenPage,
  className,
}: {
  data: LocalGraphResult;
  onOpenPage: (pageId: string) => void;
  className?: string;
}) {
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
        // circular seed (center pinned at the origin); force layout below relaxes it
        x: isCenter ? 0 : Math.cos(angle),
        y: isCenter ? 0 : Math.sin(angle),
        size: isCenter ? 9 : Math.min(4 + (degree.get(n.id) ?? 0) * 0.75, 8),
        color: isCenter ? accent : fgDim,
      });
    });
    data.edges.forEach((e, i) => {
      if (graph.hasNode(e.from) && graph.hasNode(e.to)) {
        graph.addEdgeWithKey(`e${i}`, e.from, e.to, {
          color: faint,
          size: e.type === "embed" ? 2.5 : 1,
        });
      }
    });
    if (graph.order > 2) {
      forceAtlas2.assign(graph, { iterations: 150, settings: { ...forceAtlas2.inferSettings(graph), adjustSizes: true } });
    }

    const sigma = new Sigma(graph, el, {
      renderEdgeLabels: false,
      labelColor: { color: fg },
      labelSize: 11,
      labelDensity: 1,
      minCameraRatio: 0.3,
      maxCameraRatio: 3,
    });
    // Hover: keep the hovered node + its neighbourhood, fade the rest (label off so the fade reads clearly).
    let hovered: string | null = null;
    sigma.setSetting("nodeReducer", (node, attrs) =>
      !hovered || node === hovered || graph.areNeighbors(node, hovered)
        ? attrs
        : { ...attrs, color: faint, label: "" },
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
    return () => sigma.kill();
  }, [data, theme]);

  return <div ref={ref} className={className} data-testid="local-graph-canvas" />;
}
