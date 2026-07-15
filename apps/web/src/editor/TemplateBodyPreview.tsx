import { useEffect, useRef } from "react";
import { useSession } from "../session/SessionProvider";
import { mountPublishedView } from "./editor-livepreview";
import { makeResolverSet } from "./resolver-set"; // #381 / ADR-163: image + template diagram, nothing else

// #267the template preview renders with the EDITOR'S OWN read-only engine (mountPublishedView —
// the exact CM6 surface the member view/Reading mode uses), so math (KaTeX), todo checkboxes, syntax
// highlighting, line wrapping and every macro render structurally IDENTICAL to the real page — the
// whole "preview differs from the editor" bug class is gone, not patched item by item.
//
// Read-only wiring: no onToggleTask (checkboxes render disabled), no transclude resolver / embed allowlist —
// the preview never fetches page-scoped/external resources, so transclude/embeds degrade like an editor
// without those seams. Images resolve via the member's own authorized resolver (the server re-checks view
// per attachment). #267plantuml DOES render, via a TEMPLATE-scoped, view-gated endpoint (the page
// endpoint needs a pageId this surface doesn't have) — the same `renderPlantuml` the page uses, on a body the
// viewer is already authorized to see, so no new existence exposure / external-fetch surface. XSS surface is
// unchanged: this is the same engine members already render each other's content with.
export function TemplateBodyPreview({ body, templateId, testid }: { body: string; templateId: string; testid: string }) {
  const { token } = useSession();
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = mountPublishedView(host, body, makeResolverSet({ kind: "template", token, templateId }));
    return () => {
      view.destroy();
      host.replaceChildren();
    };
  }, [body, templateId, token]);
  return <div ref={hostRef} className="wks-template-preview flex h-full min-h-0 flex-col" data-testid={testid} />;
}
