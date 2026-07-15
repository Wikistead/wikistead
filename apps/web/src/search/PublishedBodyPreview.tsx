import { useEffect, useRef } from "react";
import { useSession } from "../session/SessionProvider";
import { mountPublishedView } from "../editor/editor-livepreview";
import { makeResolverSet } from "../editor/resolver-set"; // #381 / ADR-163: image + diagram, nothing else

// #285(B): render a page's PUBLISHED body with the editor's OWN read-only engine (mountPublishedView —
// the exact CM6 surface members use for view/Reading), so math, code, todo checkboxes, and every macro look
// STRUCTURALLY IDENTICAL to the real page instead of a raw-source dump. Reusable (the search preview today;
// #348 reuses it for the page-embed picker preview). authz/XSS are UNCHANGED: the `body` must already be a
// VIEW-GATED fetch (getPublished — 404 on deny), and this is the same engine members already render each
// other's content with (no dangerouslySetInnerHTML). Read-only wiring: images resolve via the member's
// authorized resolver (server re-checks view per attachment); plantuml renders via the page-scoped, view-gated
// endpoint (the same `renderDiagram` the real page uses); no transclude/embed seams (they degrade, like the
// template preview) so the preview never fans out to other page-scoped/external resources.
export function PublishedBodyPreview({ body, pageId, testid }: { body: string; pageId: string; testid?: string }) {
  const { token } = useSession();
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = mountPublishedView(host, body, makeResolverSet({ kind: "preview", token, pageId }));
    return () => {
      view.destroy();
      host.replaceChildren();
    };
  }, [body, pageId, token]);
  return <div ref={hostRef} className="wks-published-preview flex min-h-0 flex-col" data-testid={testid} />;
}
