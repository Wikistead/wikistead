import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";
import { ChevronRight, Copy, FilePen, FilePlus, FileText, Lock, MoreHorizontal, Pencil, Pin, Share2, Trash2 } from "lucide-react";
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
}: {
  nodes: PageTreeNode[];
  selectedId: string | null;
  onOpen: (pageId: string) => void;
  canEdit?: boolean;
  openByDefault?: boolean; // read-only callers (public reader) expand the whole tree so it's browsable at a glance
  onRowAction?: (value: string, d: PageTreeNode) => void;
  // #284: pin/unpin toggle — a member-personal action, so NOT canEdit-gated (a view-only
  // member may pin). Ref-routed like onRowAction (the NodeRow identity contract, ADR-119).
  onTogglePin?: (d: PageTreeNode) => void;
  onMove?: (args: { dragIds: string[]; parentId: string | null; index: number }) => void;
  disableDrop?: (args: { parentNode: NodeApi<PageTreeNode> | null; dragNodes: NodeApi<PageTreeNode>[] }) => boolean;
}) {
  const { t } = useTranslation();
  const { ref: treeBox, size } = useSize();

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
        className="group box-border h-full w-full min-w-0 overflow-hidden select-none px-1"
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
        <span className="inline-flex flex-none items-center" onClick={(e) => { e.stopPropagation(); node.toggle(); }}>
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
            <span className="inline-flex items-center" data-testid="tree-draft-icon" title={t("sidebar.draftTitle")}>
              <FilePen size={14} className="text-fg-dim" aria-label={t("sidebar.draftTitle")} />
            </span>
          )}
          {d.published && d.unpublished ? (
            <span
              className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)] ring-1 ring-[var(--panel)]"
              data-testid="unpublished-dot"
              title={t("sidebar.unpublished")}
              aria-label={t("sidebar.unpublished")}
            />
          ) : null}
        </span>
        {/* #219: a native tooltip ONLY when the title is truncated (checked at hover via scrollWidth). */}
        {/* #315: a draft row also dims its title so "not published yet" reads from the whole row. */}
        <span className={cn("min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap", !d.published && "text-fg-dim")} data-testid="tree-page-name"
          onMouseEnter={(e) => { const el = e.currentTarget; el.title = el.scrollWidth > el.clientWidth ? (d.name || t("common.untitled")) : ""; }}>{d.name || t("common.untitled")}</span>
        {/* #109 Fix B: private (allowlist-only) lock. Shown only to viewers of the page — non-viewers 404. */}
        {d.private && <Lock size={12} className="mx-0.5 flex-none text-fg-dim" data-testid="tree-private-lock" aria-label={t("sidebar.private")} />}
        {/* #290 / ADR-114: a compact :::todo progress ring — only for pages with a :::todo (taskTotal>0). */}
        {d.taskTotal > 0 && <span className="mx-0.5 flex-none inline-flex items-center self-center" data-testid="tree-todo-ring"><ProgressRing done={d.taskDone} total={d.taskTotal} compact /></span>}
        {/* #284 / #336 A(4): a PINNED page shows its ★ ALWAYS (click to unpin — the ★ then disappears).
            Unpinned pages have NO standalone pin button; pinning moved into the row menu below, so the row
            stays narrow. Pin is a member-personal action, so still NOT canEdit-gated. */}
        {onTogglePinRef.current && d.pinned && (
          <span className="flex flex-none" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="flex cursor-pointer rounded-sm p-0.5 text-fg-dim transition-colors duration-[120ms] hover:bg-border hover:text-foreground"
              title={t("sidebar.unpin")}
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
          <span
            className={cn(
              "flex gap-0.5 transition-[opacity,transform] duration-[120ms] motion-reduce:transition-none",
              "translate-x-1 opacity-0 pointer-events-none",
              "group-hover:translate-x-0 group-hover:opacity-100 group-hover:pointer-events-auto",
              "group-focus-within:translate-x-0 group-focus-within:opacity-100 group-focus-within:pointer-events-auto",
              "has-[[aria-expanded=true]]:translate-x-0 has-[[aria-expanded=true]]:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto",
              selected && "!translate-x-0 !opacity-100 !pointer-events-auto",
            )}
            onClick={(e) => e.stopPropagation()}
          >
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
                    <DropdownMenuItem onSelect={() => onRowActionRef.current!("delete", d)} data-danger="" variant="destructive"><Trash2 size={13} /> {t("sidebar.delete")}</DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
       </div>
      </div>
    );
  }, [selectedId, canEdit, t, onOpen]);

  return (
    <div ref={treeBox} className="min-h-0 min-w-0 flex-1" data-testid="page-tree">
      <Tree<PageTreeNode>
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
