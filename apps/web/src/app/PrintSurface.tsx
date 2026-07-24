import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// #505a print-only STATIC surface. Every reading surface (member / guest / public) renders its
// body with CodeMirror (mountLivePreview / mountPublishedView), which VIRTUALISES its viewport — only the
// on-screen slice of a long document is in the DOM. Printing that prints one screenful, crushed onto a
// single sheet with a scrollbar. This portal renders the FULL published Markdown once, statically, via the
// shared sanitised renderer (renderMarkdownToDom — createTextNode/textContent, safeHref, NO innerHTML), at
// body level. @media print (print.css) hides the live app and shows only this — normal document flow, so
// the browser paginates it across as many sheets as it takes.
//
// Display-only: it READS the published Markdown the route already holds and never touches the Y.Text /
// collab session. Unpublished (draft-only) pages have no published body → nothing to print here (the
// export/print canonical is the published content, matching the HTML export).
export function PrintSurface({ md, title }: { md: string | null; title: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const host = bodyRef.current;
    if (!host) return;
    host.replaceChildren();
    if (md == null || md.trim() === "") return;
    // Lazy-import the renderer (it lives in the CM6 editor bundle; the reading route already pulls that in,
    // so this adds ~nothing eager). staticMacros keeps macros as their static/degraded form for print.
    void import("../editor/macros/md-render").then(({ renderMarkdownToDom }) => {
      if (cancelled || !bodyRef.current) return;
      bodyRef.current.replaceChildren(renderMarkdownToDom(md, undefined, { staticMacros: true }));
    });
    return () => { cancelled = true; };
  }, [md]);

  return createPortal(
    // data-print-root: print.css shows ONLY this subtree in normal flow (everything else display:none).
    // .wks-prose gives it the shared read typography; hidden off-print via the same stylesheet.
    <div data-print-root className="wks-prose" aria-hidden>
      {title ? <h1 data-testid="print-title" style={{ margin: "0 0 0.6em", fontSize: "1.8em", fontWeight: 700 }}>{title}</h1> : null}
      <div ref={bodyRef} data-testid="print-body" />
    </div>,
    document.body,
  );
}
