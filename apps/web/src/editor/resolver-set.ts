// #381 / ADR-163 §3: the ONE place that decides WHICH resource resolvers a read surface gets. Surfaces
// declare an authz CONTEXT (a closed union — adding a surface without declaring one fails to compile)
// instead of hand-picking factory subsets; that hand-picking is exactly how #376 shipped a public reader
// with `{}` (no resolvers at all). The per-resolver factories stay where they are (they already share
// private cores); this module owns only the CHOICE, and it pins today's deliberate absences:
//   - `resolveAttachment` exists ONLY on the page surface (member/guest) — no template/preview/public
//     variant exists on the server either.
//   - templates/previews get NO transclude (their bodies degrade by design).
//   - `public` is EXACTLY the ADR-149 §2 anonymous trio (image / diagram / transclude), all tokenless.
// AUTHZ IS UNCHANGED: this is client-side selection; every endpoint keeps its own server gate. The
// page-INTERACTION opts (onToggleTask, titleLinks, list, linkStatus, embedProviders) stay caller-supplied
// — they are not resource resolution.
import { makeImageResolver, makePublicImageResolver } from "./image-resolver";
import type { Bearer } from "../data/apiClient";
import { makeAttachmentResolver } from "./attachment-resolver";
import { makeDiagramRenderer, makePublicDiagramRenderer, makeTemplateDiagramRenderer } from "./diagram-renderer";
import { makeTranscludeResolver, makePublicTranscludeResolver } from "./transclude-resolver";
import type { ImageResolver, AttachmentResolver, DiagramRenderer, TranscludeResolver } from "./live-preview/decorations";

export type ResolverContext =
  // A member OR share-link guest page (the guest case is the member set with the guest token — the
  // server re-gates). pageId null = a surface with no page scope yet (diagram/transclude degrade).
  | { kind: "page"; token: Bearer; pageId: string | null }
  | { kind: "template"; token: string; templateId: string }
  // Search-hit / embed-picker previews: image + diagram only.
  | { kind: "preview"; token: string; pageId: string }
  // The anonymous public reader (ADR-149 §2) — tokenless by construction.
  | { kind: "public"; pageId: string };

export interface ResolverSet {
  resolveImageUrl?: ImageResolver;
  resolveAttachment?: AttachmentResolver;
  renderDiagram?: DiagramRenderer;
  resolveTransclude?: TranscludeResolver;
}

export function makeResolverSet(ctx: ResolverContext): ResolverSet {
  switch (ctx.kind) {
    case "page":
      return {
        resolveImageUrl: makeImageResolver(ctx.token),
        resolveAttachment: makeAttachmentResolver(ctx.token),
        ...(ctx.pageId
          ? { renderDiagram: makeDiagramRenderer(ctx.token, ctx.pageId), resolveTransclude: makeTranscludeResolver(ctx.token, ctx.pageId) }
          : {}),
      };
    case "template":
      return {
        resolveImageUrl: makeImageResolver(ctx.token),
        renderDiagram: makeTemplateDiagramRenderer(ctx.token, ctx.templateId),
      };
    case "preview":
      return {
        resolveImageUrl: makeImageResolver(ctx.token),
        renderDiagram: makeDiagramRenderer(ctx.token, ctx.pageId),
      };
    case "public":
      return {
        resolveImageUrl: makePublicImageResolver(),
        renderDiagram: makePublicDiagramRenderer(ctx.pageId),
        resolveTransclude: makePublicTranscludeResolver(ctx.pageId),
      };
  }
}
