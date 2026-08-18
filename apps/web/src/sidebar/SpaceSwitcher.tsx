import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, ChevronsUpDown, FolderDown, FolderUp, Loader2, Pencil, Pin, Plus } from "lucide-react";
import { Command, CommandInput, CommandList, CommandItem, CommandGroup, CommandSeparator } from "../components/ui/command";
import { SpaceIcon } from "../ui/SpaceIcon";
import { cn } from "../lib/utils";
import { useSpaceNameSearch, useSpacesByName, type Space } from "../data/queries";
import { visibleSpaces, recordRecentSpace } from "./space-recent";

// #263: the space switcher. #226 auto-creates a personal space per member, so a flat list of every
// viewable space grows unbounded (a tenant admin sees everyone's). The default view is now BOUNDED — the
// current space + recently-used spaces (space-recent.ts) — with an incremental SEARCH over ALL viewable
// spaces (client-side, over the server's FGA-filtered useSpaces set only, so no new permission surface).
// cmdk gives ↑↓/Enter.

export function SpaceSwitcher({
  spaces, hasMoreSpaces = false, currentId, currentSpace, canManage, onSelect, onRename, onNewSpace, canCreateSpace = true, onExportSpace, exportingSpace = false,
  onImportSpace,
  pinnedSpaceIds = [], onTogglePin, onMovePin,
}: {
  spaces: Space[];
  // #710: whether the roster's first page has a next page — drives the "show all" entry point
  // (a boolean by design; the count of unseen spaces is not the client's to know).
  hasMoreSpaces?: boolean;
  currentId: string | undefined;
  currentSpace: Space | undefined;
  canManage: boolean;
  onSelect: (id: string) => void;
  onRename: () => void;
  onNewSpace: () => void;
  // #445hide the entry point when the tenant role says the member may not create spaces.
  // Convenience only — the server refuses regardless, and a stale flag still surfaces the 403's
  // reason as a toast (two-layer rule: UI is convenience, the server is the fortress).
  canCreateSpace?: boolean;
  // #284: the member's pinned space ids (server pin order, view-confirmed) + the ★ toggle.
  // Pinned spaces render first and are exempt from the bounded-list folding.
  pinnedSpaceIds?: string[];
  onTogglePin?: (spaceId: string) => void;
  // v1 reorder = up/down (ADR-119): move a pinned space within the pin order.
  onMovePin?: (spaceId: string, dir: -1 | 1) => void;
  // #309: download the current space as a Markdown ZIP. NOT canManage-gated — the server export is
  // view-filtered, so every member may use it (Open formats / no lock-in). exportingSpace keeps the
  // item disabled + spinning while the archive is being generated (it can take a while).
  onExportSpace?: () => void;
  exportingSpace?: boolean;
  // #308 / ADR-132: import an export ZIP into the current space (manage-gated UI; server gates edit). The
  // #725: the item navigates to the space's import screen; the caller decides where that is.
  onImportSpace?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false); // #287: "show all" — full name-sorted list
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [open]);

  // #263 rejection ②: focus the search input WITHOUT scrolling. cmdk's `autoFocus` calls focus plainly,
  // whose scroll-into-view drags the overflow-hidden sidebar root horizontally (scrollLeft>0) → the whole
  // header row visibly shifts left. Focusing with { preventScroll: true } ourselves eliminates that shift.
  const focusSearch = () => boxRef.current?.querySelector<HTMLInputElement>("[data-slot=command-input]")?.focus({ preventScroll: true });
  useEffect(() => { if (open) { focusSearch(); setExpanded(false); } }, [open]); // #287: reset "show all" on each open

  // #287: a query always searches ALL spaces (bounded/expanded is only for the no-query browse). With no
  // query, "expanded" shows every space name-sorted; otherwise the bounded default (current + recents).
  // #705 v1: a typed query asks the SERVER, so it matches every space the caller may see — not just
  // the roster pages in hand. The answer flows through visibleSpaces for the same ordering rules;
  // hasMore drives a non-numeric "more matches" line (no total — the review's density-oracle ruling).
  const search = useSpaceNameSearch(query);
  const searching = query.trim().length > 0;
  // #710 C: "show all" pages the SERVER's name-ordered walk (#287's order, keyset (name, id))
  // the client no longer sorts a roster it no longer holds. Pages accumulate only as the reader
  // asks for them (the load-more item below); nothing walks on its own.
  const byName = useSpacesByName(!searching && expanded);
  const allByName = useMemo(() => (byName.data?.pages ?? []).flatMap((p) => p.spaces), [byName.data]);
  const list = useMemo(
    () => (!searching && expanded
      ? allByName
      : visibleSpaces(searching ? (search.data?.spaces ?? []) : spaces, currentId, query, pinnedSpaceIds)),
    [spaces, currentId, query, expanded, pinnedSpaceIds, searching, search.data, allByName],
  );
  // #710 D: the entry point is offered whenever the bounded default may be hiding something — the
  // pool folded some spaces, or the roster has pages beyond the first. NO NUMBER: the old count
  // came from holding the whole roster, and a first-page count would silently under-state (the
  // " N N " failurenames). Non-numeric copy instead.
  const showAllEntry = !searching && !expanded && (hasMoreSpaces || spaces.length > list.length);
  const moreMatches = searching && (search.data?.hasMore ?? false);

  const select = (id: string) => { onSelect(id); recordRecentSpace(id); setOpen(false); setQuery(""); };

  return (
    <div className="relative min-w-0 flex-1" ref={boxRef}>
      <button
        type="button"
        data-testid="space-switcher"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 font-semibold text-foreground transition-colors duration-[120ms] hover:bg-panel-2"
      >
        {currentSpace && <SpaceIcon id={currentSpace.id} name={currentSpace.name} image={currentSpace.iconImageUrl} size={20} data-testid="space-icon" />}
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{currentSpace?.name || t("sidebar.noSpace")}</span>
        <ChevronsUpDown size={14} className="flex-none" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 max-w-[calc(var(--sidebar-w,260px)-0.75rem)] rounded-md border border-border bg-popover text-popover-foreground shadow-md" data-testid="space-menu">
          <Command shouldFilter={false} className="bg-transparent">
            <CommandInput value={query} onValueChange={setQuery} placeholder={t("sidebar.searchSpaces")} data-testid="space-search" />
            <CommandList className="max-h-[40vh]">
              {/* #295: cmdk's <CommandEmpty> only fires when its internal filtered count is 0, but the rename
                  and new-space items below are always present (count >= 2), so it NEVER rendered and the
                  message was dead code. shouldFilter is off (we filter app-side into `list`), so render the
                  no-match message explicitly when a non-empty query matches no space. */}
              {query.trim() !== "" && list.length === 0 && (
                <div className="px-3 py-4 text-center text-sm text-muted-foreground" data-testid="space-empty">
                  {t("sidebar.noSpacesMatch")}
                </div>
              )}
              <CommandGroup>
                {list.map((s) => {
                  const pinIdx = pinnedSpaceIds.indexOf(s.id);
                  const pinned = pinIdx >= 0;
                  // #284: hover-revealed pin controls (★ toggle; up/down while pinned). stopPropagation on
                  // pointerdown+click so a control click never selects/switches the space (cmdk item).
                  const guard = (e: { stopPropagation(): void; preventDefault(): void }) => { e.stopPropagation(); e.preventDefault(); };
                  const ctlBtn = "flex flex-none cursor-pointer rounded-sm p-0.5 text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
                  return (
                    <CommandItem key={s.id} value={`space:${s.id}`} onSelect={() => select(s.id)} data-testid="space-option" className="group/space">
                      <SpaceIcon id={s.id} name={s.name} image={s.iconImageUrl} size={18} />
                      <span className="truncate">{s.name || t("sidebar.untitledSpace")}</span>
                      {onTogglePin && (
                        <span className="ml-auto flex flex-none items-center gap-0.5">
                          {pinned && onMovePin && !query.trim() && !expanded && (
                            <span className={cn("flex gap-0.5 transition-opacity duration-[120ms] group-hover/space:opacity-100", "opacity-0")}>
                              <button type="button" className={ctlBtn} disabled={pinIdx === 0} data-tip={t("sidebar.movePinUp")} aria-label={t("sidebar.movePinUp")} data-testid="space-pin-up" onPointerDown={guard} onClick={(e) => { guard(e); onMovePin(s.id, -1); }}><ChevronUp size={13} /></button>
                              <button type="button" className={ctlBtn} disabled={pinIdx === pinnedSpaceIds.length - 1} data-tip={t("sidebar.movePinDown")} aria-label={t("sidebar.movePinDown")} data-testid="space-pin-down" onPointerDown={guard} onClick={(e) => { guard(e); onMovePin(s.id, 1); }}><ChevronDown size={13} /></button>
                            </span>
                          )}
                          <button
                            type="button"
                            className={cn(ctlBtn, "transition-opacity duration-[120ms] group-hover/space:opacity-100", pinned ? "opacity-100" : "opacity-0")}
                            data-tip={pinned ? t("sidebar.unpin") : t("sidebar.pin")}
                            aria-label={pinned ? t("sidebar.unpin") : t("sidebar.pin")}
                            aria-pressed={pinned}
                            data-testid="space-pin-toggle"
                            onPointerDown={guard}
                            onClick={(e) => { guard(e); onTogglePin(s.id); }}
                          >
                            <Pin size={13} className={pinned ? "fill-current" : undefined} />
                          </button>
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
                {showAllEntry && (
                  // #287: the default list is capped, so offer a SELECTABLE "show all" item (↑↓/Enter/click)
                  // that browses every viewable space name-sorted — server-paged since #710.
                  <CommandItem value="__show-all" onSelect={() => setExpanded(true)} data-testid="space-show-all" className="text-muted-foreground">
                    {t("sidebar.showAllSpaces")}
                  </CommandItem>
                )}
                {!searching && expanded && byName.hasNextPage && (
                  <CommandItem value="__show-more" disabled={byName.isFetchingNextPage} onSelect={() => { void byName.fetchNextPage(); }} data-testid="space-show-more" className="text-muted-foreground">
                    {byName.isFetchingNextPage ? <Loader2 size={13} className="animate-spin" /> : null} {t("sidebar.moreSpaces")}
                  </CommandItem>
                )}
                {moreMatches && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground" data-testid="space-more-matches">
                    {t("sidebar.moreSpaceMatches")}
                  </div>
                )}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                {currentSpace && canManage && (
                  <CommandItem value="__rename" onSelect={() => { onRename(); setOpen(false); }} data-testid="space-rename">
                    <Pencil size={13} /> {t("sidebar.renameSpace")}
                  </CommandItem>
                )}
                {/* #309: export the current space (Markdown ZIP). The menu STAYS OPEN with the item
                    disabled + spinning while the archive is generated, so the in-flight state is visible;
                    the caller closes nothing — the user sees the browser download start. */}
                {currentSpace && onExportSpace && (
                  <CommandItem value="__export" disabled={exportingSpace} onSelect={() => { if (!exportingSpace) onExportSpace(); }} data-testid="space-export">
                    {exportingSpace ? <Loader2 size={13} className="animate-spin" /> : <FolderDown size={13} />} {t("export.spaceItem")}
                  </CommandItem>
                )}
                {/* #725 / ADR-236: import OPENS ITS SCREEN. It used to run from a hidden file input here
                    and report a two-number toast, which threw away the fidelity report ADR-227 exists to
                    produce and had nowhere to put the progress of a large (202) import. The menu keeps
                    the entry because this is where people look for it; the work happens on the tab. */}
                {currentSpace && canManage && onImportSpace && (
                  <CommandItem value="__import" onSelect={() => { setOpen(false); onImportSpace(); }} data-testid="space-import">
                    <FolderUp size={13} /> {t("import.spaceItem")}
                  </CommandItem>
                )}
                {canCreateSpace && (
                  <CommandItem value="__new" onSelect={() => { onNewSpace(); setOpen(false); }} data-testid="space-new">
                    <Plus size={13} /> {t("sidebar.newSpace")}
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
