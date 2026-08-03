import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { DiagramHostSeam } from "../editor/macros/md-render";

// #505 a print-only STATIC surface. Every reading surface (member / guest / public) renders its
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
// #207 (review rejection, measured again here): this portal drew its macros with NO host seams, so the
// one print path the app cannot intercept produced a page where `plantuml` was its own source and an
// external embed was the sentence "not shown on this surface". The app's own Print does not have that
// problem — it hands the export the same seams the editor has — which is precisely why the drift went
// unnoticed: the road people use was right, and the road the browser takes was not.
//
// So the seams come in as props. A surface that has no renderer for something passes nothing and the macro
// degrades exactly as it does anywhere else (an embed with no allowlist becomes a link, which is the honest
// thing to put on paper).
export function PrintSurface({ md, title, diagram }: {
  md: string | null;
  title: string;
  diagram?: DiagramHostSeam | null;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const host = bodyRef.current;
    if (!host) return;
    host.replaceChildren();
    if (md == null || md.trim() === "") return;
    // Lazy-import the renderer (it lives in the CM6 editor bundle; the reading route already pulls that in,
    // so this adds ~nothing eager).
    void import("../editor/macros/md-render").then(async ({ renderMarkdownToDom, withDiagramHost, withEmbedHost }) => {
      if (cancelled || !bodyRef.current) return;
      const { buildEmbedElement } = await import("../editor/macros/embed");
      if (cancelled || !bodyRef.current) return;
      // An external embed on PAPER is a link, always: a printed iframe is a blank rectangle, and the
      // ruling for anything that cannot round-trip is to degrade rather than to show a hole
      // (`exportFidelity: "degrade"`). Passing an empty allowlist is how that is said — the same builder
      // the screen uses, taking its own degrade branch, rather than a second way to draw an embed.
      const embed = { build: (url: string) => buildEmbedElement(url, []) };
      // LIVE macros (#85): the static mode renders a diagram as a compact chip, which is the "export shows
      // source, screen shows a figure" gap on the one path that still comes through here. These renders are
      // asynchronous and fill themselves in — the portal is built when the body changes, long before anyone
      // reaches for File → Print, so by then they have drawn.
      withDiagramHost(diagram ?? null, () => withEmbedHost(embed, () => {
        bodyRef.current!.replaceChildren(renderMarkdownToDom(md));
      }));
    });
    return () => { cancelled = true; };
  }, [md, diagram]);

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
