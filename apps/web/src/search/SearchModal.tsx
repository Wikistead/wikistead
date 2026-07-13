import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useSearch, useSpaces, usePage, usePublished } from "../data/queries";
import { useDebouncedValue } from "./useDebouncedValue";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from "../components/ui/command";
import { PageMeta } from "../app/PageMeta";
import { SpaceIcon } from "../ui/SpaceIcon";
import { PublishedBodyPreview } from "./PublishedBodyPreview";

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
export function SearchModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const debounced = useDebouncedValue(input, 250);
  const { data: hits, isFetching } = useSearch(open ? debounced : "");
  const spaces = useSpaces();
  // cmdk's highlighted value (a page id) — drives the preview pane, debounced so arrowing through
  // the list doesn't fire a view-gated fetch per keypress.
  const [selected, setSelected] = useState("");
  const previewId = useDebouncedValue(selected, 200);
  const pageQ = usePage(open ? previewId : "");
  const publishedQ = usePublished(open ? previewId : "");

  // #285(C): keep the whole space summary (icon + name), not just the name, so results show a space
  // ICON. iconImageUrl is already assetUrl-prefixed by useSpaces; accentKey/id seed the initials fallback.
  const spaceById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; iconImageUrl?: string | null }>();
    for (const s of spaces.data ?? []) m.set(s.id, { id: s.id, name: s.name || "Untitled space", iconImageUrl: s.iconImageUrl });
    return m;
  }, [spaces.data]);

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
    navigate(`/p/${id}`);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setInput(""); onOpenChange(o); }}>
      <DialogContent className="max-w-3xl overflow-hidden p-0" showCloseButton={false} position="top">
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
                <div className="p-2 text-sm text-fg-dim">{t("search.searching")}</div>
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
            <div className="hidden max-h-[60vh] flex-1 overflow-y-auto p-4 md:block" data-testid="search-preview">
              {previewId && pageQ.data ? (
                <>
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 truncate text-sm font-bold">{pageQ.data.title || t("common.untitled")}</div>
                    {!pageQ.data.published && <span className="shrink-0 text-xs text-fg-dim" data-testid="search-preview-draft">{t("page.draft")}</span>}
                  </div>
                  <PageMeta createdBy={pageQ.data.createdBy} updatedBy={pageQ.data.updatedBy} updatedAt={pageQ.data.updatedAt} />
                  {/* #285(B): render the view-gated PUBLISHED body with the member read-engine so it
                      looks like the real page (not a source dump). A draft (no published body) shows an
                      explicit placeholder instead of an empty pane. */}
                  <div className="mt-3" data-testid="search-preview-body">
                    {publishedQ.data?.publishedMd
                      ? <PublishedBodyPreview body={publishedQ.data.publishedMd} pageId={previewId} testid="search-preview-rendered" />
                      : publishedQ.isFetching
                        ? <div className="text-xs text-fg-dim">{t("search.searching")}</div>
                        : <div className="text-xs text-fg-dim" data-testid="search-preview-unpublished">{t("search.previewUnpublished")}</div>}
                  </div>
                </>
              ) : (
                <div className="text-sm text-fg-dim">{previewId && (pageQ.isFetching || publishedQ.isFetching) ? t("search.searching") : ""}</div>
              )}
            </div>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
