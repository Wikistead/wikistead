import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useSearch, useResolvedSpaces, usePage, usePublished, useGuestPublished } from "../data/queries";
import { useDebouncedValue } from "./useDebouncedValue";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from "../components/ui/command";
import { PageMeta } from "../app/PageMeta";
import { SpaceIcon } from "../ui/SpaceIcon";
import { PublishedBodyPreview } from "./PublishedBodyPreview";
import { PanelRowsSkeleton, ProseSkeleton, useDelayedFlag } from "../ui/Skeleton"; // #457

// #285 / ADR-118: the search MODAL — a command dialog with the result list on the left and a preview
// pane (selected hit) on the right. authz invariants (the review's re-check list,):
//  (a) `shouldFilter={false}` — cmdk does NO client filtering; the list is EXACTLY the server's
//      two-stage-guarded (Meili tenant token → FGA view confirm) result set.
//  (b) the preview NEVER renders Meili stage-1 data: it re-fetches the selected page through the
//      view-gated routes (GET /pages/:id + /pages/:id/published — both 404 uniformly on deny), so a
//      hit that somehow slipped stage-2 still shows nothing (defence in depth).
//  (c) the preview body renders as PLAIN TEXT (whiteSpace pre-wrap; never dangerouslySetInnerHTML).
//  (d) the draft badge derives from the view-gated `published` boolean (published_at IS NOT NULL) —
//      NOT the manage-gated isPagePublic (which would leak publish state).
// #449 / ADR-173: a space-link GUEST reuses this exact modal. `guestToken` routes the search through
// the guest's own token (the server forces the link's space + gates every hit on the share_link
// principal); `onNavigate` replaces the member `/p/<id>` route with the guest tree's own open handler
// so a hit stays inside `/share/…`.
// #449 addendum (review ruling): the guest gets the preview pane too — fetched through the
// EXISTING guest-authorized route (`GET /pages/:id/published` with the guest token: share_link FGA
// view + non_expired context, uniform 404 on deny), NEVER the member meta route (`GET /pages/:id`),
// which stays disabled for guests (previewId is fed only to the member hooks when !isGuest). Same
// two-layer posture as (b): a hit that slipped stage-2 still previews nothing (404 → empty pane).
// The guest pane shows title + rendered body only — /published returns no creator data by design
// (#318 minimal-field policy), and drafts never reach guest results (fortress), so no draft badge.
export function SearchModal({ open, onOpenChange, guestToken, onNavigate }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  guestToken?: string;
  onNavigate?: (pageId: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isGuest = guestToken != null;
  const [input, setInput] = useState("");
  const debounced = useDebouncedValue(input, 250);
  const { data: hits, isFetching } = useSearch(open ? debounced : "", guestToken);
  // #710: resolve exactly the spaces the HITS name (one batch over distinct ids) — the roster walk
  // that fetched every space to label a dozen results is gone. Member-only; a guest has no
  // cross-space resolution (and the guest surface renders no space chips).
  const hitSpaceIds = useMemo(() => [...new Set((hits ?? []).map((h) => h.spaceId).filter(Boolean))], [hits]);
  const resolved = useResolvedSpaces(hitSpaceIds, !isGuest);
  // cmdk's highlighted value (a page id) — drives the preview pane, debounced so arrowing through
  // the list doesn't fire a view-gated fetch per keypress.
  const [selected, setSelected] = useState("");
  const debouncedSelected = useDebouncedValue(selected, 200);
  const previewId = open ? debouncedSelected : "";
  // #449 addendum: the member hooks stay OFF for a guest (a guest token never rides member routes);
  // the guest preview reads the guest-authorized /published route instead (see the header comment).
  const pageQ = usePage(isGuest ? "" : previewId);
  const publishedQ = usePublished(isGuest ? "" : previewId);
  const guestQ = useGuestPublished(isGuest ? previewId : "", guestToken ?? "");
  // #457result-list and preview loading draw skeletons instead of a "searching…" text line —
  // both delay-gated so a fast query/fetch never flashes them (the shared anti-flicker rule).
  const showListSkeleton = useDelayedFlag(isFetching && (hits ?? []).length === 0);
  const showPreviewSkeleton = useDelayedFlag(
    previewId.length > 0 && (isGuest ? guestQ.isFetching : pageQ.isFetching || publishedQ.isFetching),
  );

  // #285(C): keep the whole space summary (icon + name), not just the name, so results show a space
  // ICON. iconImageUrl is already assetUrl-prefixed by useSpaces; accentKey/id seed the initials fallback.
  const spaceById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; iconImageUrl?: string | null }>();
    for (const s of Object.values(resolved.data ?? {})) {
      if (s) m.set(s.id, { id: s.id, name: s.name || "Untitled space", iconImageUrl: s.iconImageUrl });
    }
    return m;
  }, [resolved.data]);

  const items = useMemo(
    () => (hits ?? []).map((h) => ({
      value: h.id,
      label: h.title || "Untitled",
      space: spaceById.get(h.spaceId) ?? null,
      snippet: h.snippet ?? "",
    })),
    [hits, spaceById],
  );

  const go = (id: string) => {
    onOpenChange(false);
    setInput("");
    if (onNavigate) onNavigate(id); // #449: guest tree opens the page inside /share/…
    else navigate(`/p/${id}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setInput(""); onOpenChange(o); }}>
      {/* #285widen to 5xl (1024px) so the 2-pane list + rich preview isn't cramped — the preview
          pane's reading line-length drove the choice.
          #285the "0px side gutter at 640–1024px" bounce is structurally fixed by #365 (fdc019e), which
          rebased DialogContent onto `w-[calc(100vw-4rem)]` — a WIDTH the per-dialog `sm:max-w-5xl` only CAPS
          (never widens). So the effective width is min(100vw-4rem, 64rem): a 2rem/side gutter is always kept at
          narrow/mid widths, and 5xl still governs the ceiling on wide screens. No per-dialog max-w override is
          needed here anymore; the gutter pin in search.spec guards the regression. Mobile 1-column unchanged. */}
      <DialogContent className="sm:max-w-5xl overflow-hidden p-0" showCloseButton={false} position="top">
        <DialogHeader className="sr-only"><DialogTitle>{t("search.placeholder")}</DialogTitle></DialogHeader>
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          className="bg-transparent"
          onKeyDown={(e) => {
            // Ctrl-j/k = list nav, the app-wide cmdk convention (Ctrl-n is browser-reserved).
            if (e.ctrlKey && (e.key === "j" || e.key === "k")) {
              e.preventDefault();
              e.currentTarget.dispatchEvent(new KeyboardEvent("keydown", { key: e.key === "j" ? "ArrowDown" : "ArrowUp", bubbles: true }));
            }
          }}
        >
          <CommandInput
            value={input}
            onValueChange={setInput}
            data-testid="search-input"
            placeholder={t("search.placeholder")}
            autoFocus
          />
          <div className="flex min-h-0" data-testid="search-results">
            <CommandList className="max-h-[60vh] w-full overflow-y-auto md:w-2/5 md:border-r">
              {isFetching && items.length === 0 ? (
                // #457row skeletons while results load (delay-gated: a fast query renders nothing)
                <div className="p-2">{showListSkeleton ? <PanelRowsSkeleton testid="search-list-skeleton" rows={5} /> : null}</div>
              ) : items.length === 0 ? (
                input.trim() ? <CommandEmpty>{t("search.noResults")}</CommandEmpty> : <div className="p-2 text-sm text-fg-dim">{t("search.placeholder")}</div>
              ) : (
                items.map((item) => (
                  <CommandItem
                    key={item.value}
                    value={item.value}
                    data-testid="search-item"
                    onSelect={go}
                    className="flex flex-col items-start gap-0.5"
                  >
                    <span className="text-sm">{item.label}</span>
                    {item.space && (
                      <span className="flex items-center gap-1 text-xs text-fg-dim" data-testid="search-item-space">
                        <SpaceIcon id={item.space.id} name={item.space.name} image={item.space.iconImageUrl} size={12} />
                        {item.space.name}
                      </span>
                    )}
                    {item.snippet && <span className="text-xs text-fg-dim" data-testid="search-snippet">{item.snippet}</span>}
                  </CommandItem>
                ))
              )}
            </CommandList>
            {/* the preview pane (md+ only — narrow screens keep the single-column list). Everything here
                comes from the view-gated routes for the SELECTED page (b/d above); a deny (404) simply
                leaves the pane empty — no oracle. */}
            <div className="max-h-[60vh] flex-1 overflow-y-auto p-4 hidden md:block" data-testid="search-preview">
              {isGuest ? (
                // #449 addendum: the GUEST pane — title + rendered published body from the guest-gated
                // /published fetch (no PageMeta / draft badge: minimal fields, fortress keeps drafts out).
                previewId && guestQ.data ? (
                  <>
                    <div className="min-w-0 truncate text-sm font-bold">{guestQ.data.title || t("common.untitled")}</div>
                    <div className="mt-3" data-testid="search-preview-body">
                      {guestQ.data.publishedMd
                        ? <PublishedBodyPreview body={guestQ.data.publishedMd} pageId={previewId} testid="search-preview-rendered" tokenOverride={guestToken} />
                        : <div className="text-xs text-fg-dim" data-testid="search-preview-unpublished">{t("search.previewUnpublished")}</div>}
                    </div>
                  </>
                ) : (
                  showPreviewSkeleton ? <ProseSkeleton testid="search-preview-skeleton" /> : null
                )
              ) : previewId && pageQ.data ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 truncate text-sm font-bold">{pageQ.data.title || t("common.untitled")}</div>
                    {!pageQ.data.published && <span className="shrink-0 text-xs text-fg-dim" data-testid="search-preview-draft">{t("page.draft")}</span>}
                  </div>
                  <PageMeta createdBy={pageQ.data.createdBy} updatedBy={pageQ.data.updatedBy} updatedAt={pageQ.data.updatedAt} createdByName={pageQ.data.createdByName} createdByHasAvatar={pageQ.data.createdByHasAvatar} updatedByName={pageQ.data.updatedByName} updatedByHasAvatar={pageQ.data.updatedByHasAvatar} />
                  {/* #285(B): render the view-gated PUBLISHED body with the member read-engine so it
                      looks like the real page (not a source dump). A draft (no published body) shows an
                      explicit placeholder instead of an empty pane. */}
                  <div className="mt-3" data-testid="search-preview-body">
                    {publishedQ.data?.publishedMd
                      ? <PublishedBodyPreview body={publishedQ.data.publishedMd} pageId={previewId} testid="search-preview-rendered" />
                      : publishedQ.isFetching
                        ? (showPreviewSkeleton ? <ProseSkeleton testid="search-preview-skeleton" /> : null)
                        : <div className="text-xs text-fg-dim" data-testid="search-preview-unpublished">{t("search.previewUnpublished")}</div>}
                  </div>
                </>
              ) : (
                showPreviewSkeleton ? <ProseSkeleton testid="search-preview-skeleton" /> : null
              )}
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
