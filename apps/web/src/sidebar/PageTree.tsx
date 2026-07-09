import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";
import { ChevronRight, Copy, FilePen, FilePlus, FileText, Lock, MoreHorizontal, Pencil, Share2, Trash2 } from "lucide-react";
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
  onMove,
  disableDrop,
}: {
  nodes: PageTreeNode[];
  selectedId: string | null;
  onOpen: (pageId: string) => void;
  canEdit?: boolean;
  openByDefault?: boolean; // read-only callers (public reader) expand the whole tree so it's browsable at a glance
  onRowAction?: (value: string, d: PageTreeNode) => void;
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
            tooltip lives on a wrapping span (a title attribute on an <svg> shows no native tooltip). */}
        {d.published ? (
          <FileText size={14} className="flex-none text-fg-dim" />
        ) : (
          <span className="inline-flex flex-none items-center" data-testid="tree-draft-icon" title={t("sidebar.draftTitle")}>
            <FilePen size={14} className="text-fg-dim" aria-label={t("sidebar.draftTitle")} />
          </span>
        )}
        {/* #219: a native tooltip ONLY when the title is truncated (checked at hover via scrollWidth). */}
        {/* #315: a draft row also dims its title so "not published yet" reads from the whole row. */}
        <span className={cn("min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap", !d.published && "text-fg-dim")} data-testid="tree-page-name"
          onMouseEnter={(e) => { const el = e.currentTarget; el.title = el.scrollWidth > el.clientWidth ? (d.name || t("common.untitled")) : ""; }}>{d.name || t("common.untitled")}</span>
        {/* #109 Fix B: private (allowlist-only) lock. Shown only to viewers of the page — non-viewers 404. */}
        {d.private && <Lock size={12} className="mx-0.5 flex-none text-fg-dim" data-testid="tree-private-lock" aria-label={t("sidebar.private")} />}
        {/* 3-state: Draft (FilePen icon, above) / Unpublished changes (dot) / clean (nothing). The #315
            text pill is gone — draft is carried by the file icon swap, so the two states stay distinct. */}
        {d.published && d.unpublished ? (
          <span className="mx-1 h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent)]" data-testid="unpublished-dot" title={t("sidebar.unpublished")} aria-label={t("sidebar.unpublished")} />
        ) : null}
        {/* #290 / ADR-114: a compact :::todo progress ring — only for pages with a :::todo (taskTotal>0). */}
        {d.taskTotal > 0 && <span className="mx-0.5 flex-none inline-flex items-center self-center" data-testid="tree-todo-ring"><ProgressRing done={d.taskDone} total={d.taskTotal} compact /></span>}
        {canEdit && onRowActionRef.current && (
          <span className="flex gap-0.5 opacity-0 pointer-events-none transition-opacity duration-[120ms] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger className="flex cursor-pointer rounded-sm p-0.5 text-fg-dim transition-colors duration-[120ms] hover:bg-border hover:text-foreground" aria-label={t("sidebar.pageActions")} data-testid="page-actions"><MoreHorizontal size={14} /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" data-testid="page-menu">
                <DropdownMenuItem onSelect={() => onRowActionRef.current!("subpage", d)} data-testid="add-subpage"><FilePlus size={13} /> {t("sidebar.addSubpage")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRowActionRef.current!("share", d)}><Share2 size={13} /> {t("sidebar.share")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRowActionRef.current!("rename", d)}><Pencil size={13} /> {t("sidebar.rename")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRowActionRef.current!("duplicate", d)} data-testid="tree-duplicate-page"><Copy size={13} /> {t("page.duplicatePage")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRowActionRef.current!("delete", d)} data-danger="" variant="destructive"><Trash2 size={13} /> {t("sidebar.delete")}</DropdownMenuItem>
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
