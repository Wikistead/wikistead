// #465: give a rendered diagram SVG an INTRINSIC width so it isn't collapsed to the CSS default
// replaced-element size (300×150).
//
// The diagram wrap is `display:flex; align-items:center` (the #255 align-left/center/right classes),
// which shrink-to-fits its item instead of stretching it. Mermaid emits `width="100%"` + a viewBox —
// percentage width is NOT an intrinsic size, so the width resolution is circular and the browser
// falls back to 300px, shrinking a 650px diagram to under half. Excalidraw's exportToSvg has the
// same shape. Setting a px `width` from the viewBox fixes the circularity; the inline
// `max-width: 100%` (which must be inline — mermaid writes its own inline `max-width: <n>px` that
// would otherwise win over the stylesheet) keeps it from overflowing a narrow column, and
// `height: auto` preserves the aspect ratio. Standard responsive-SVG shape; the align classes keep
// working because the item now has a real size to center/left/right.
export function applyIntrinsicSvgSize(root: HTMLElement | SVGElement | null | undefined): void {
  if (!root) return;
  const svg = root instanceof SVGSVGElement ? root : root.querySelector?.("svg");
  if (!svg) return;
  const width = intrinsicWidthOf(svg);
  if (width == null || !(width > 0)) return;
  svg.setAttribute("width", String(width));
  svg.style.maxWidth = "100%";
  svg.style.height = "auto";
}

// The natural width: the viewBox's width (the diagram's own coordinate extent) — or, failing that,
// the px value of whatever inline max-width the renderer wrote (mermaid's `max-width: 650px`).
function intrinsicWidthOf(svg: SVGElement): number | null {
  const viewBox = svg.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n)) && parts[2]! > 0) return parts[2]!;
  }
  const declared = svg.style.maxWidth || svg.getAttribute("width") || "";
  const px = /^([\d.]+)px$/.exec(declared.trim());
  return px ? Number(px[1]) : null;
}
