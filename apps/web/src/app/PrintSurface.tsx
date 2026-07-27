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
// #85 / ADR-194: the app's OWN print action (menu, Ctrl+P) no longer comes through here — it builds the
// export document in the browser and prints that. This portal remains for the one print path the app cannot
// intercept: the BROWSER's own File → Print, which fires natively with no chance to build anything
// asynchronously first. Without it that path prints the virtualised editor, which is the defect #505 opened
// with. It is not a second renderer — it is the same markdown renderer the app reads with, now rendering macros LIVE
// so a diagram on this path is a diagram too, and wearing `.wks-prose`, whose face the same sheet declares
// for every surface. Retiring it needs a way to intercept native print, which does not exist.
//
// Display-only: it READS the published Markdown the route already holds and never touches the Y.Text /
// collab session.
export function PrintSurface({ md, title }: { md: string | null; title: string }) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const host = bodyRef.current;
    if (!host) return;
    host.replaceChildren();
    if (md == null || md.trim() === "") return;
    // Lazy-import the renderer (it lives in the CM6 editor bundle; the reading route already pulls that in,
    // so this adds ~nothing eager).
    void import("../editor/macros/md-render").then(({ renderMarkdownToDom }) => {
      if (cancelled || !bodyRef.current) return;
      // LIVE macros (#85): the static mode renders a diagram as a compact chip, which is the "export shows
      // source, screen shows a figure" gap on the one path that still comes through here. These renders are
      // asynchronous and fill themselves in — the portal is built when the body changes, long before anyone
      // reaches for File → Print, so by then they have drawn.
      bodyRef.current.replaceChildren(renderMarkdownToDom(md));
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
