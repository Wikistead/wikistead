import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from "react-arborist";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";
import { ChevronRight, Copy, FilePen, FilePlus, FileText, Lock, MoreHorizontal, Pencil, Pin, Share2, Snowflake, Trash2 } from "lucide-react";
import { ProgressRing } from "../app/ProgressRing"; // #290: sidebar :::todo progress ring
import { cn } from "../lib/utils";

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

export function PageTree({
  nodes,
  selectedId,
  onOpen,
  canEdit = false,
  openByDefault = false,
  onRowAction,
  onTogglePin,
  onMove,
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
  onMove?: (args: { dragIds: string[]; parentId: string | null; index: number }) => void;
  disableDrop?: (args: { parentNode: NodeApi<PageTreeNode> | null; dragNodes: NodeApi<PageTreeNode>[] }) => boolean;
}) {
  const { t } = useTranslation();
  const { ref: treeBox, size } = useSize();
  // #274 (3): keep the ACTIVE row visible — after creating a page the app navigates to it,
  // but in a long (virtualized) tree the new row could sit outside the viewport. `nodes` is a dep on
  // purpose: the freshly created row only exists after the tree refetch, so the scroll fires once it
  // renders. nearest-style scrolling (react-arborist keeps it minimal), never a jump on ordinary clicks.
  const treeRef = useRef<TreeApi<PageTreeNode> | null>(null);
  useEffect(() => {
    if (selectedId) treeRef.current?.scrollTo(`page:${selectedId}`);
  }, [selectedId, nodes]);

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

  const NodeRow = useCallback(({ node, style, dragHandle }: NodeRendererProps<PageTreeNode>) => {
    const d = node.data;
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
         className={cn(
           "flex h-full w-full min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg pr-2 transition-colors duration-[120ms]",
           selected
             ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel-3))] font-medium"
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
        {/* #219: a tooltip ONLY when the title is truncated (checked at hover via scrollWidth). */}
        {/* #530: `data-tip` (the delegated fast tooltip), not `title` — this row is the tooltip the user
            named as too slow. Same hover-time truncation check; clearing the attribute when the name fits
            keeps a full-width name tooltip-free. */}
        {/* #315: a draft row also dims its title so "not published yet" reads from the whole row. */}
        <span className={cn("min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap", !d.published && "text-fg-dim")} data-testid="tree-page-name"
          onMouseEnter={(e) => { const el = e.currentTarget; if (el.scrollWidth > el.clientWidth) el.dataset.tip = d.name || t("common.untitled"); else delete el.dataset.tip; }}>{d.name || t("common.untitled")}</span>
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
  }, [selectedId, canEdit, t, onOpen, deleteMode]);

  return (
    // #398: expose the measured tree width as a CSS var so a row can cap its width to it. react-arborist's
    // drag preview clones a row into a position:fixed FULL-WIDTH overlay (still inside this DOM subtree, so the
    // var cascades) where the row's `w-full` would otherwise stretch to the viewport — a selected row (its menu
    // force-expanded) then produced a viewport-wide ghost. Capping to --tree-w keeps the preview sidebar-width.
    <div ref={treeBox} className="min-h-0 min-w-0 flex-1" data-testid="page-tree" style={{ "--tree-w": `${size.width || 260}px` } as React.CSSProperties}>
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
        onActivate={(n: NodeApi<PageTreeNode>) => onOpen(n.data.pageId)}
      >
        {NodeRow}
      </Tree>
    </div>
  );
}
