import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from "../components/ui/command";
import { useSearch, useSpaces } from "../data/queries";
import { useDebouncedValue } from "../search/useDebouncedValue";
import { HitPreviewPane } from "../search/HitPreviewPane";
import { SpaceIcon } from "../ui/SpaceIcon";

// #205 part 2 / ADR-071: the title-search page picker for `:::embed-page`. Candidates come from
// GET /search — the SAME two-stage guard (Meili + FGA `view`) as global search — and cmdk runs with
// shouldFilter={false}, so the list is EXACTLY the server's authorized set: a page the user can't
// view is never offered (no existence leak; no client re-filter can add one). An id can also be typed
// directly (the raw-id fallback), so embedding stays possible even when a query returns nothing.
// #323: onPick also reports the picked hit's TITLE (null for cancel / the raw-id fallback) so the
// page-LINK insert can write `[title](/p/id)` without a second fetch. Embed consumers ignore it.
export function PageEmbedPicker({ open, onPick }: { open: boolean; onPick: (pageId: string | null, title?: string | null) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const debounced = useDebouncedValue(input, 250);
  const { data: hits } = useSearch(debounced);
  const spaces = useSpaces();
  const space = (id: string) => (spaces.data ?? []).find((s) => s.id === id) ?? null;
  const spaceName = (id: string) => space(id)?.name ?? "";
  // #348: the highlighted hit id drives the right preview pane, debounced so arrowing doesn't fetch per keypress.
  const [selected, setSelected] = useState("");
  const previewId = useDebouncedValue(selected, 200);

  const close = (id: string | null, title?: string | null) => { setInput(""); onPick(id, title ?? null); };
  // A raw id (or url tail) typed directly — the escape hatch when search can't reach a page (e.g. a
  // brand-new page not yet indexed). Trimmed; only offered when it looks like a bare token.
  const raw = input.trim();
  const looksLikeId = raw.length > 0 && !/\s/.test(raw);
  // #332item 4 / #366auto-highlight the FIRST REAL hit so Enter confirms immediately. cmdk with a
  // controlled value + shouldFilter={false} does NOT re-select when the list changes, so we drive it.bug:
  // on a query change hits briefly drops to [] (1 frame), leaving only the raw-id fallback → the old effect
  // selected it AND then never recovered (raw stays in the list, so `includes(selected)` was true). Fix: the raw
  // fallback is auto-selected ONLY when there are NO real hits; otherwise the first real hit wins. A MANUAL nav
  // (arrows / Ctrl-j/k) pins the user's choice (incl. the raw row) until the query changes — tracked by
  // `userNavRef`, reset whenever the typed query changes.
  const userNavRef = useRef(false);
  useEffect(() => { userNavRef.current = false; }, [raw]); // a new query → resume auto-selecting the first hit
  useEffect(() => {
    if (userNavRef.current) return; // the user picked a row by hand → don't yank it from under them
    const ids = (hits ?? []).map((h) => h.id);
    const target = ids.length > 0 ? ids[0]! : looksLikeId ? `__raw__${raw}` : "";
    if (selected !== target) setSelected(target);
  }, [hits, looksLikeId, raw, selected]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(null); }}>
      {/* #348: widen to a 2-pane picker (list + rich preview), like the search modal; a narrow viewport keeps
          the single-column list (the preview pane is md:block only). */}
      {/* #366FIXED modal height (centered, equal top/bottom margins) so navigating hits — which changes
          the preview body height — no longer stretches/shrinks the modal (the jitter). Each pane scrolls on its
          own within that fixed box. Small screens keep the single-column, content-height list. */}
      <DialogContent className="sm:max-w-5xl overflow-hidden p-0 flex flex-col h-[min(72vh,44rem)]" showCloseButton={false}>
        <DialogHeader className="sr-only"><DialogTitle>{t("embedPicker.title")}</DialogTitle></DialogHeader>
        <Command
          shouldFilter={false}
          value={selected}
          onValueChange={setSelected}
          className="flex min-h-0 flex-1 flex-col bg-transparent"
          onKeyDown={(e) => {
            // #366any MANUAL list nav pins the user's selection (so a query-change auto-select can't yank it).
            if (e.key === "ArrowDown" || e.key === "ArrowUp" || (e.ctrlKey && (e.key === "j" || e.key === "k"))) userNavRef.current = true;
            // Ctrl-j/k = list nav (the app-wide cmdk convention; Ctrl-n is browser-reserved).
            if (e.ctrlKey && (e.key === "j" || e.key === "k")) {
              e.preventDefault();
              e.currentTarget.dispatchEvent(new KeyboardEvent("keydown", { key: e.key === "j" ? "ArrowDown" : "ArrowUp", bubbles: true }));
            }
          }}
        >
          <CommandInput
            value={input}
            onValueChange={setInput}
            data-testid="embed-picker-input"
            placeholder={t("embedPicker.placeholder")}
            autoFocus
          />
          <div className="flex min-h-0 flex-1">
            <CommandList className="min-w-0 flex-1 min-h-0 max-h-none overflow-y-auto md:max-w-xs md:border-r md:border-border">
              <CommandEmpty>{t("embedPicker.empty")}</CommandEmpty>
              {(hits ?? []).map((h) => (
                <CommandItem key={h.id} value={h.id} onSelect={() => close(h.id, h.title || null)} data-testid="embed-picker-item">
                  <div className="flex min-w-0 items-center gap-2">
                    {space(h.spaceId) && <SpaceIcon id={h.spaceId} name={spaceName(h.spaceId)} image={space(h.spaceId)!.iconImageUrl} size={12} />}
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{h.title || t("common.untitled")}</span>
                      {/* #205: same-name pages are told apart by space + snippet — all view-authorized (FGA gate). */}
                      <span className="truncate text-xs text-fg-dim">
                        {spaceName(h.spaceId)}{spaceName(h.spaceId) && h.snippet ? " · " : ""}{h.snippet ?? ""}
                      </span>
                    </div>
                  </div>
                </CommandItem>
              ))}
              {looksLikeId && (
                <CommandItem value={`__raw__${raw}`} onSelect={() => close(raw)} data-testid="embed-picker-raw">
                  {t("embedPicker.useId", { id: raw })}
                </CommandItem>
              )}
            </CommandList>
            {/* #348: the shared rich preview of the highlighted hit (view-gated body — same as the search modal). */}
            <HitPreviewPane pageId={open ? previewId : ""} testid="embed-picker-preview" />
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
