import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SELECTED_ROW } from "../ui/selected-row"; // #632: shared with the settings nav
import { useTranslation } from "react-i18next";
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from "react-arborist";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";
import { ChevronRight, Copy, FilePen, FilePlus, FileText, Lock, MoreHorizontal, Pencil, Pin, Share2, Snowflake, Trash2 } from "lucide-react";
import { ProgressRing } from "../app/ProgressRing"; // #290: sidebar :::todo progress ring
import { cn } from "../lib/utils";
import { UNLOADED_CHILD_PREFIX, PLACEHOLDER_PREFIX, MORE_PREFIX, PLACEHOLDERS_MORE_PREFIX } from "./lazy-tree"; // #623 §6.3, #1141
import { alignSelectedRow, decideScroll, NO_SCROLL_YET, type ScrollMemory } from "./scroll-to-selection"; // #899

// The presentational page-tree — the ONE react-arborist tree + row renderer shared by every surface that
// shows a space's page hierarchy: the member `Sidebar`, and (read-only) the anonymous public reader-chrome
// (#227). Callers inject the nodes + selection + an `onOpen(pageId)` navigator; member callers additionally
// pass `canEdit` + the row-action / DnD handlers. A read-only caller (public) passes none of those, so no
// row menu, no drag-and-drop, and the draft/unpublished/private/ring badges naturally collapse (public nodes
// are all published, non-private, ring-less). This holds NO data-fetching — the security boundary lives in
// the caller's data source (the public shell only ever feeds it `/public/*` results), never here.
export interface PageTreeNode {
  id: string; // "page:<id>"
  name: string;
  pageId: string;
  spaceId: string;
  published: boolean;
  unpublished: boolean;
  private: boolean;
  frozen?: "full" | "guests" | null; // #329 rework: freeze level — pairs a snowflake with the lock
  taskDone: number; // #290: :::todo checkbox aggregate (taskTotal>0 → show the ring)
  taskTotal: number;
  pinned?: boolean; // #284: this page is pinned by the CURRENT member (drives the ★ toggle state)
  children?: PageTreeNode[];
}

/**
 * #736 / #899: where is this row in the tree we are about to render? The effect waits for the selected
 * row to exist (#274), and its structural path distinguishes paging after the row (leave the reader
 * alone) from a gap window inserted before it (re-align the row that insertion pushed off-screen).
 */
function rowPosition(nodes: PageTreeNode[], rowId: string, parent = ""): string | null {
  for (const [index, node] of nodes.entries()) {
    const position = parent ? `${parent}.${index}` : String(index);
    if (node.id === rowId) return position;
    if (node.children?.length) {
      const childPosition = rowPosition(node.children, rowId, position);
      if (childPosition !== null) return childPosition;
    }
  }
  return null;
}

// #193: measure the tree container via a CALLBACK ref, not an effect keyed on a stable ref object. The
// container is mounted CONDITIONALLY, so an effect that runs on first commit finds ref.current === null,
// returns early, and never re-runs. A callback ref (re)attaches the observer whenever the node mounts and
// seeds the size synchronously so the first paint is already correct. (react-arborist needs a pixel width.)
function useSize() {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const roRef = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    roRef.current = ro;
    const r = el.getBoundingClientRect(); // seed immediately (RO may not fire synchronously)
    setSize({ width: r.width, height: r.height });
  }, []);
  return { ref, size };
}

/**
 * #623 §1 / #745: the branch's next page arrives by scrolling. Virtualisation also renders rows near
 * a programmatically aligned selection, so visibility alone is not proof of reader intent. Wait for
 * interaction with this selection before treating a mounted sentinel as a paging request.
 */
function TreeLoadingRow() {
  const { t } = useTranslation();
  return (
    <div
      className="flex h-full items-center gap-2 px-3"
      data-testid="tree-branch-loading"
      role="status"
      aria-label={t("common.loading")}
    >
      <span className="size-3.5 flex-none animate-pulse rounded-sm bg-border motion-reduce:animate-none" />
      <span className="h-2.5 w-2/3 animate-pulse rounded-full bg-border motion-reduce:animate-none" />
    </div>
  );
}

function MoreRow({ enabled, onVisible }: { enabled: boolean; onVisible: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const asked = useRef(false);
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(false);
  const ask = useCallback(() => {
    if (asked.current) return;
    asked.current = true;
    setLoading(true);
    void Promise.resolve(onVisible()).finally(() => setLoading(false));
  }, [onVisible]);
  useEffect(() => {
    if (enabled) {
      ask();
      return;
    }
    const host = rowRef.current?.closest<HTMLElement>("[data-testid=page-tree]");
    if (!host) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) ask();
    };
    host.addEventListener("wheel", ask, { capture: true });
    host.addEventListener("touchmove", ask, { capture: true });
    host.addEventListener("pointerdown", ask, { capture: true });
    host.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      host.removeEventListener("wheel", ask, { capture: true });
      host.removeEventListener("touchmove", ask, { capture: true });
      host.removeEventListener("pointerdown", ask, { capture: true });
      host.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [enabled, ask]);
  return (
    <div ref={rowRef} className="h-full" data-testid="tree-branch-more" data-loading={loading || undefined}>
      {loading ? (
        <TreeLoadingRow />
      ) : (
        <button
          type="button"
          // #1130: no size override — inherits the tree's 14px like a page name/placeholder row
          // does (#1123), instead of the 11px text-xs this row and tree-placeholders-exhausted
          // below were left at, both worse than the 12px #1123 fixed.
          className="flex h-full w-full cursor-pointer items-center px-3 text-left text-fg-dim hover:text-foreground"
          onClick={ask}
        >
          {t("sidebar.loadMorePages")}
        </button>
      )}
    </div>
  );
}

export function PageTree({
  nodes,
  selectedId,
  onOpen,
  canEdit = false,
  openByDefault = false,
  onRowAction,
  onTogglePin,
  onMove,
  onToggleBranch,
  onLoadMore,
  onLoadMorePlaceholders,
  disableDrop,
  deleteMode = "trash_only",
}: {
  nodes: PageTreeNode[];
  selectedId: string | null;
  onOpen: (pageId: string) => void;
  canEdit?: boolean;
  openByDefault?: boolean; // read-only callers (public reader) expand the whole tree so it's browsable at a glance
  onRowAction?: (value: string, d: PageTreeNode) => void;
  // #437 / ADR-167: the space's resolved deletion-pathway policy — shapes which delete entries the
  // row menu offers (trash / permanent / both). UI only; the server routes gate regardless.
  deleteMode?: "trash_only" | "both" | "direct_only";
  // #284: pin/unpin toggle — a member-personal action, so NOT canEdit-gated (a view-only
  // member may pin). Ref-routed like onRowAction (the NodeRow identity contract, ADR-119).
  onTogglePin?: (d: PageTreeNode) => void;
  // #623 §6.3: a lazy caller is told which page row opened/closed, so it can fetch that branch. The
  // sentinel child (`unloaded:`) is what made the chevron draw before anything was fetched.
  onToggleBranch?: (pageId: string, open: boolean) => void;
  /** §1: the `more:` row asks for the branch's next page when it scrolls into view. */
  onLoadMore?: (parentId: string | null) => void | Promise<void>;
  /** #1141 / ADR-220 §4.2 rev13: the `ph-more:` row asks for the branch's next placeholder walk step. */
  onLoadMorePlaceholders?: (parentId: string | null) => void | Promise<void>;
  onMove?: (args: { dragIds: string[]; parentId: string | null; index: number }) => void;
  disableDrop?: (args: { parentNode: NodeApi<PageTreeNode> | null; dragNodes: NodeApi<PageTreeNode>[] }) => boolean;
}) {
  const { t } = useTranslation();
  const { ref: treeBox, size } = useSize();
  const treeHostRef = useRef<HTMLDivElement | null>(null);
  const attachTreeBox = useCallback((el: HTMLDivElement | null) => {
    treeHostRef.current = el;
    treeBox(el);
  }, [treeBox]);
  // #274 (3): keep the ACTIVE row visible — after creating a page the app navigates to it, but
  // in a long (virtualized) tree the new row only exists after the refetch, so the scroll has to wait
  // for it to appear. #736: that used to be spelled `nodes` in the dep list, which meant EVERY change
  // to the tree scrolled back to the open page — including §1's paging, where `more:` appends into the
  // same cache entry and hands us a new array. A reader scrolling past the open page was pulled back
  // on every page they loaded. The trigger is now the event, not the identity: scroll when the
  // SELECTION changes, when the selected row APPEARS for the first time (#274), or when a window fills
  // a gap before that row and changes its structural position. Appending after the row changes none of
  // those, so ordinary paging still leaves the reader's viewport alone.
  const treeRef = useRef<TreeApi<PageTreeNode> | null>(null);
  const selectedRowPosition = useMemo(
    () => (selectedId ? rowPosition(nodes, `page:${selectedId}`) : null),
    [nodes, selectedId],
  );
  // #899: the rule lives in `decideScroll`, as a pure function, because it is the rule that breaks
  // and a rule that exists only inside an effect can be measured only by rendering. What it adds to
  // #736 is a third state: a row that DISAPPEARED and came back is a fresh appearance, not the same
  // one. #899 also records its structural position, because filling a gap before a still-present row
  // can push it out of the viewport without ever producing the absent state.
  const scrollMemoryRef = useRef<ScrollMemory>(NO_SCROLL_YET);
  const readerMovedRef = useRef(false);
  const [pagingInteractionFor, setPagingInteractionFor] = useState<string | null>(null);
  const pagingEnabled = pagingInteractionFor === selectedId;
  const previousSelectionRef = useRef(selectedId);
  if (previousSelectionRef.current !== selectedId) {
    previousSelectionRef.current = selectedId;
    readerMovedRef.current = false;
  }
  useEffect(() => {
    const { scroll, next } = decideScroll(
      scrollMemoryRef.current,
      selectedId,
      selectedRowPosition !== null,
      selectedRowPosition,
      !readerMovedRef.current,
    );
    if (!scroll || !selectedId) {
      scrollMemoryRef.current = next;
      return;
    }
    let cancelled = false;
    const afterLayout = () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    void alignSelectedRow({
      scroll: async () => { await treeRef.current?.scrollTo(`page:${selectedId}`, "center"); },
      afterLayout,
      isCancelled: () => cancelled,
      isVisible: () => {
        const row = treeHostRef.current?.querySelector<HTMLElement>("[data-testid=tree-page][data-selected]");
        if (!row) return false;
        let scroller: HTMLElement | null = row.parentElement;
        while (scroller && scroller !== treeHostRef.current && scroller.scrollHeight <= scroller.clientHeight + 4) {
          scroller = scroller.parentElement;
        }
        const rowRect = row.getBoundingClientRect();
        const boxRect = (scroller ?? treeHostRef.current)?.getBoundingClientRect();
        return !!boxRect && rowRect.top >= boxRect.top - 1 && rowRect.bottom <= boxRect.bottom + 1;
      },
    }).then((aligned) => {
      if (aligned && !cancelled) scrollMemoryRef.current = next;
    });
    return () => { cancelled = true; };
  }, [selectedId, selectedRowPosition]);

  // Route the row action through a ref so NodeRow's identity does NOT depend on it. NodeRow is the
  // react-arborist row renderer: if its identity changes on a re-render, react-arborist REMOUNTS every row —
  // which detaches an open row menu's trigger (Radix then closes the menu mid-click). Keeping NodeRow stable
  // (memoised on only render-affecting values) keeps tree rows — and any open menu — alive.
  const onRowActionRef = useRef(onRowAction);
  onRowActionRef.current = onRowAction;
  // #284: same ref contract for the pin toggle — a fresh callback prop captured inside
  // NodeRow would change its identity and remount every row (the Radix menu-close bug).
  const onTogglePinRef = useRef(onTogglePin);
  onTogglePinRef.current = onTogglePin;
  // #623 §6.3: same ref contract — a fresh callback identity would remount every row (the Radix bug).
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const onLoadMorePlaceholdersRef = useRef(onLoadMorePlaceholders);
  onLoadMorePlaceholdersRef.current = onLoadMorePlaceholders;
  const onToggleBranchRef = useRef(onToggleBranch);
  onToggleBranchRef.current = onToggleBranch;
  const markReaderInteraction = useCallback(() => {
    readerMovedRef.current = true;
    setPagingInteractionFor(selectedId);
  }, [selectedId]);

  const NodeRow = useCallback(({ node, style, dragHandle }: NodeRendererProps<PageTreeNode>) => {
    const d = node.data;
    // #623 §6.3: the three synthetic rows a lazy branch produces. None is a page: no open, no menu,
    // no drag, no pin — §4.7's "not usable" said in the renderer.
    if (d.id.startsWith(UNLOADED_CHILD_PREFIX)) {
      // The instant between expanding a row and its branch arriving. Exists mostly unseen: the parent
      // draws its chevron because of this child, and the fetch replaces it on the next render.
      return <TreeLoadingRow />;
    }
    if (d.id.startsWith(MORE_PREFIX)) {
      // `more:<parent>:<cursor>` — the cursor is part of the IDENTITY (a fixed id survived the
      // append, its mount-once guard stayed spent, and page three never loaded). Parents are uuids and
      // never contain a colon, so the first segment is the parent.
      const parentId = d.id.slice(MORE_PREFIX.length).split(":")[0]!;
      return (
        <MoreRow
          key={d.id}
          enabled={pagingEnabled}
          onVisible={() => onLoadMoreRef.current?.(parentId === "root" ? null : parentId)}
        />
      );
    }
    if (d.id.startsWith(PLACEHOLDERS_MORE_PREFIX)) {
      // #1141 / ADR-220 §4.2 rev13: more of this branch's invisible territory remains — exactly
      // MORE_PREFIX's own row and cursor-in-id contract, targeting the placeholder walk
      // instead of the branch's own pagination. Superseded the #1079 "budget ran out" dead-end row.
      const parentId = d.id.slice(PLACEHOLDERS_MORE_PREFIX.length).split(":")[0]!;
      return (
        <MoreRow
          key={d.id}
          enabled={pagingEnabled}
          onVisible={() => onLoadMorePlaceholdersRef.current?.(parentId === "root" ? null : parentId)}
        />
      );
    }
    if (d.id.startsWith(PLACEHOLDER_PREFIX)) {
      // §4 / ruling ②: one fixed, unnamed label for every cause — private, draft and restricted are
      // indistinguishable here on purpose. Expandable only; its children are already in hand.
      return (
        <div className="flex h-full w-full min-w-0 items-center gap-1.5 px-1 select-none" data-testid="tree-placeholder">
          <span
            className="flex size-4 flex-none cursor-pointer items-center justify-center"
            onClick={(e) => { e.stopPropagation(); node.toggle(); }}
            data-testid="tree-placeholder-chevron"
          >
            <ChevronRight size={13} className={cn("text-fg-dim transition-transform duration-[120ms]", node.isOpen && "rotate-90")} />
          </span>
          {/* #1123: the label inherits the row's size (14px) like a page name does — its own `text-sm`
              (12px in tokens.css) made the one row a reader cannot open the smallest row in the tree.
              Italic + dim still separate it from a real page; only the SIZE is shared. */}
          <span className="truncate italic text-fg-dim">{d.name}</span>
        </div>
      );
    }
    const selected = d.pageId === selectedId;
    const hasChildren = (d.children?.length ?? 0) > 0;
    // #193 (rebuilt as ONE structure): react-arborist positions each row in a wrapper of exactly
    // rowHeight(32px) × 100%, and passes us `style` = the depth indent (paddingLeft) only + the dragHandle
    // ref. OUTER fills that slot; INNER is the highlight + click target; ROW = chevron + icon + name(truncate)
    // + badges/actions(flex-none). Click area == highlight == the whole slot; no horizontal overflow.
    const indent = typeof (style as { paddingLeft?: number }).paddingLeft === "number" ? (style as { paddingLeft: number }).paddingLeft : 0;
    return (
      <div
        ref={dragHandle}
        className="group box-border h-full w-full min-w-0 max-w-[var(--tree-w,260px)] overflow-hidden select-none px-1"
        data-testid="tree-page"
        data-selected={selected ? "" : undefined}
        onClick={() => onOpen(d.pageId)}
      >
       <div
         // #530: the tooltip is anchored to the ROW and MEASURES the name inside it. Anchoring it to the
         // name meant the hover buttons shrank the name out from under the cursor mid-hover, the pointer
         // landed on the row instead, and the host treated that as leaving — so the row that most needed
         // its name shown was the one that would not show it.
         data-tip-if-truncated={d.name || t("common.untitled")}
         data-tip-measure="[data-testid=tree-page-name]"
         className={cn(
           "flex h-full w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg pr-2 transition-colors duration-[120ms]",
           selected
             ? SELECTED_ROW
             : "hover:bg-panel-2",
         )}
         style={{ paddingLeft: `calc(${indent}px + 0.5rem)` }} // indent shifts only the content; 8px label room
       >
        {/* #451: the expand toggle's HIT AREA is a 24×24 box (icon stays 14px, centered) — the
            negative margins keep the occupied width at ~14px so the title indent and the childless
            spacer alignment don't move. stopPropagation keeps row-click (open) and toggle separate. */}
        <span
          className={cn(
            "inline-flex h-6 w-6 flex-none items-center justify-center rounded-md -my-1.5 -mx-[5px]",
            hasChildren && "cursor-pointer hover:bg-[color-mix(in_srgb,var(--fg)_8%,transparent)]",
          )}
          data-testid="tree-expand-toggle"
          onClick={hasChildren ? (e) => { e.stopPropagation(); node.toggle(); } : undefined}
        >
          {hasChildren ? <ChevronRight size={14} className={cn("transition-transform duration-[120ms]", node.isOpen && "rotate-90")} /> : <span className="inline-block w-[14px]" />}
        </span>
        {/* #315: a draft (never-published) page swaps the file icon itself — zero extra row width. The
            tooltip lives on a wrapping span (a title attribute on an <svg> shows no native tooltip).
            #336 A(1): the "unpublished changes" dot is now a badge overlaid on the icon's bottom-right
            (was a separate inline slot that ate row width and truncated the title early). 3-state stays
            distinct: draft = FilePen · published+unpublished = FileText + dot · clean = FileText. */}
        <span className="relative inline-flex flex-none items-center">
          {d.published ? (
            <FileText size={14} className="text-fg-dim" />
          ) : (
            <span className="inline-flex items-center" data-testid="tree-draft-icon" data-tip={t("sidebar.draftTitle")}>
              <FilePen size={14} className="text-fg-dim" aria-label={t("sidebar.draftTitle")} />
            </span>
          )}
          {d.published && d.unpublished ? (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)] ring-1 ring-[var(--panel)]"
              data-testid="unpublished-dot"
              data-tip={t("sidebar.unpublished")}
              aria-label={t("sidebar.unpublished")}
            />
          ) : null}
        </span>
        {/* #219 / #530: the delegated fast tooltip (not `title` — this row is the one the user named as
            too slow), and only when the name is actually clipped. `data-tip-if-truncated` lets the HOST
            measure that at show time: on mouse-enter the row's hover buttons have not appeared yet, and
            they are what clips the name. */}
        {/* #315: a draft row also dims its title so "not published yet" reads from the whole row. */}
        <span className={cn("min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap", !d.published && "text-fg-dim")} data-testid="tree-page-name">{d.name || t("common.untitled")}</span>
        {/* #109 Fix B: private (allowlist-only) lock. Shown only to viewers of the page — non-viewers 404. */}
        {d.private && <Lock size={12} className="mx-0.5 flex-none text-fg-dim" data-testid="tree-private-lock" aria-label={t("sidebar.private")} />}
        {/* #329 rework: freeze badge, paired with the lock (the title bar shows both, so the tree does too). */}
        {d.frozen && (
          <span className="mx-0.5 flex-none inline-flex items-center" data-testid="tree-frozen-badge"
            data-tip={d.frozen === "full" ? t("page.frozenFull") : t("page.frozenGuests")}>
            <Snowflake size={12} className="text-fg-dim" aria-label={d.frozen === "full" ? t("page.frozenFull") : t("page.frozenGuests")} />
          </span>
        )}
        {/* #290 / ADR-114: a compact :::todo progress ring — only for pages with a :::todo (taskTotal>0). */}
        {/* #361 point 3: animKey lets the ring animate ACROSS the react-arborist row remounts
            (value-changed mounts replay prev→new via the shared CSS transition; see ProgressRing). */}
        {d.taskTotal > 0 && <span className="mx-0.5 flex-none inline-flex items-center self-center" data-testid="tree-todo-ring"><ProgressRing done={d.taskDone} total={d.taskTotal} compact animKey={d.id} /></span>}
        {/* #284 / #336 A(4): a PINNED page shows its ★ ALWAYS (click to unpin — the ★ then disappears).
            Unpinned pages have NO standalone pin button; pinning moved into the row menu below, so the row
            stays narrow. Pin is a member-personal action, so still NOT canEdit-gated. */}
        {onTogglePinRef.current && d.pinned && (
          <span className="flex flex-none" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="flex cursor-pointer rounded-sm p-0.5 text-fg-dim transition-colors duration-[120ms] hover:bg-border hover:text-foreground"
              data-tip={t("sidebar.unpin")}
              aria-label={t("sidebar.unpin")}
              aria-pressed
              data-testid="tree-pin-toggle"
              onClick={() => onTogglePinRef.current!(d)}
            >
              <Pin size={13} className="fill-current" />
            </button>
          </span>
        )}
        {/* #336 A(3): the row menu is shown only on hover / selected / open (else it takes zero width so the
            title truncates later), sliding in from the right (motion-reduce disables the slide). It holds the
            canEdit page actions AND — for an unpinned page — the "Pin" action (A(4)). Rendered whenever there
            is ANY action for this row: canEdit items, or the pin item for a non-canEdit member. */}
        {((canEdit && onRowActionRef.current) || (onTogglePinRef.current && !d.pinned)) && (
          // #343: the row menu collapses to ZERO WIDTH when idle (not just opacity-0, which kept ~19px of
          // reserved width and floated the lock/ring/★ a slot in from the edge). A `grid-template-columns`
          // 0fr→1fr animation grows the real width, so the lock/ring/★ sit flush at the row's right edge and
          // the title truncates later; on reveal they glide left as the menu takes its width (one motion, no
          // extra transform). `-ml-1.5` cancels the row's `gap-1.5` while collapsed so nothing is reserved.
          // Reveal on hover / focus-within (keyboard) / while the menu is open (aria-expanded) / selected.
          <span
            className={cn(
              "grid transition-[grid-template-columns,margin] duration-[120ms] motion-reduce:transition-none",
              "grid-cols-[0fr] -ml-1.5",
              "group-hover:grid-cols-[1fr] group-hover:ml-0",
              "group-focus-within:grid-cols-[1fr] group-focus-within:ml-0",
              "has-[[aria-expanded=true]]:grid-cols-[1fr] has-[[aria-expanded=true]]:ml-0",
              selected && "!grid-cols-[1fr] !ml-0",
            )}
            data-testid="tree-row-menu"
            onClick={(e) => e.stopPropagation()}
          >
           <span className="flex gap-0.5 overflow-hidden">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger className="flex cursor-pointer rounded-sm p-0.5 text-fg-dim transition-colors duration-[120ms] hover:bg-border hover:text-foreground" aria-label={t("sidebar.pageActions")} data-testid="page-actions"><MoreHorizontal size={14} /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" data-testid="page-menu">
                {onTogglePinRef.current && !d.pinned && (
                  <DropdownMenuItem onSelect={() => onTogglePinRef.current!(d)} data-testid="tree-pin-menu-item"><Pin size={13} /> {t("sidebar.pin")}</DropdownMenuItem>
                )}
                {canEdit && onRowActionRef.current && (
                  <>
                    <DropdownMenuItem onSelect={() => onRowActionRef.current!("subpage", d)} data-testid="add-subpage"><FilePlus size={13} /> {t("sidebar.addSubpage")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onRowActionRef.current!("share", d)}><Share2 size={13} /> {t("sidebar.share")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onRowActionRef.current!("rename", d)}><Pencil size={13} /> {t("sidebar.rename")}</DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onRowActionRef.current!("duplicate", d)} data-testid="tree-duplicate-page"><Copy size={13} /> {t("page.duplicatePage")}</DropdownMenuItem>
                    {deleteMode !== "direct_only" && (
                      <DropdownMenuItem onSelect={() => onRowActionRef.current!("delete", d)} data-danger="" variant="destructive"><Trash2 size={13} /> {t("sidebar.delete")}</DropdownMenuItem>
                    )}
                    {(deleteMode === "both" || deleteMode === "direct_only") && (
                      <DropdownMenuItem onSelect={() => onRowActionRef.current!("deleteForever", d)} data-danger="" variant="destructive" data-testid="tree-delete-forever"><Trash2 size={13} /> {t("sidebar.deleteForever")}</DropdownMenuItem>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
           </span>
          </span>
        )}
       </div>
      </div>
    );
  }, [selectedId, canEdit, t, onOpen, deleteMode, pagingEnabled]);

  return (
    // #398: expose the measured tree width as a CSS var so a row can cap its width to it. react-arborist's
    // drag preview clones a row into a position:fixed FULL-WIDTH overlay (still inside this DOM subtree, so the
    // var cascades) where the row's `w-full` would otherwise stretch to the viewport — a selected row (its menu
    // force-expanded) then produced a viewport-wide ghost. Capping to --tree-w keeps the preview sidebar-width.
    <div
      ref={attachTreeBox}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto"
      data-testid="page-tree"
      style={{ "--tree-w": `${size.width || 260}px` } as React.CSSProperties}
      onWheelCapture={markReaderInteraction}
      onTouchMoveCapture={markReaderInteraction}
      onPointerDownCapture={markReaderInteraction}
      onKeyDownCapture={(event) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) {
          markReaderInteraction();
        }
      }}
    >
      <Tree<PageTreeNode>
        ref={treeRef}
        className="!overflow-x-hidden"
        // #193 bounce: react-arborist forces each row wrapper to a content min-width; we hide horizontal
        // scroll, so override it to 0 (!min-w-0) — now the row = viewport width and the name truncates.
        rowClassName="!min-w-0"
        data={nodes}
        idAccessor="id"
        childrenAccessor="children"
        openByDefault={openByDefault}
        width={size.width || 260}
        height={size.height || 400}
        indent={14}
        rowHeight={32}
        selection={selectedId ? `page:${selectedId}` : undefined}
        disableMultiSelection
        disableDrag={!canEdit}
        disableDrop={disableDrop ?? (() => true)}
        onMove={onMove}
        onActivate={(n: NodeApi<PageTreeNode>) => { if (n.data.pageId) onOpen(n.data.pageId); }}
        // #623 §6.3: tell the lazy caller which BRANCH opened. Arborist reports the id only; the
        // direction is read back from the node, post-toggle.
        onToggle={(id: string) => {
          if (!id.startsWith("page:")) return;
          const open = treeRef.current?.get(id)?.isOpen ?? true;
          onToggleBranchRef.current?.(id.slice(5), open);
        }}
      >
        {NodeRow}
      </Tree>
    </div>
  );
}
