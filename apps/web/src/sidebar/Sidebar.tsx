import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "../components/ui/dropdown-menu";
import { ChevronRight, ChevronsUpDown, FilePlus, FileText, MoreHorizontal, Pencil, Plus, Settings, Share2, Trash2 } from "lucide-react";
import {
  useSpaces,
  useCreateSpace,
  useRenameSpace,
  useCreatePage,
  useRenamePage,
  useDeletePage,
  useMovePage,
  type Page,
} from "../data/queries";
import { apiFetch } from "../data/apiClient";
import { useSession } from "../session/SessionProvider";
import { useActiveSpace } from "../app/ActiveSpace";
import { RenameDialog, ConfirmDialog } from "../ui/dialogs";
import { ShareDialog } from "../ui/ShareDialog";
import { SpaceIcon } from "../ui/SpaceIcon";
import { cn } from "../lib/utils";

// One space at a time (Notion/Outline style): the sidebar shows ONLY the active
// space's page tree; the space itself is chosen in the switcher, not a tree root.
interface Node {
  id: string; // "page:<id>"
  name: string;
  pageId: string;
  spaceId: string;
  published: boolean;
  unpublished: boolean;
  children?: Node[];
}

function buildPageNodes(pages: Page[], parentId: string | null): Node[] {
  return pages
    .filter((p) => p.parentId === parentId)
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ id: `page:${p.id}`, name: p.title, pageId: p.id, spaceId: p.spaceId, published: p.published ?? false, unpublished: p.hasUnpublishedChanges ?? false, children: buildPageNodes(pages, p.id) }));
}

function useSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ width: e.contentRect.width, height: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

export function Sidebar() {
  const { t } = useTranslation();
  const { token } = useSession();
  const navigate = useNavigate();
  const { pageId } = useParams<{ pageId: string }>();
  const { activeSpaceId, setActiveSpaceId } = useActiveSpace();

  const spacesQ = useSpaces();
  const spaces = useMemo(() => spacesQ.data ?? [], [spacesQ.data]);

  // Active space: the stored choice if it still exists, else the first space.
  const current = useMemo(
    () => (activeSpaceId && spaces.find((s) => s.id === activeSpaceId) ? activeSpaceId : spaces[0]?.id),
    [activeSpaceId, spaces],
  );
  // Seed/repair the stored active space (first load, or the stored one was deleted).
  useEffect(() => {
    if (current && current !== activeSpaceId) setActiveSpaceId(current);
  }, [current, activeSpaceId, setActiveSpaceId]);

  const pagesQ = useQuery({
    queryKey: ["pages", current],
    queryFn: () => apiFetch<Page[]>(`/spaces/${current}/pages`, token).then((r) => r ?? []),
    enabled: !!current,
    staleTime: 30_000,
  });
  const pages = useMemo(() => pagesQ.data ?? [], [pagesQ.data]);
  const pageById = useMemo(() => new Map(pages.map((p) => [p.id, p])), [pages]);
  const data = useMemo(() => buildPageNodes(pages, null), [pages]);

  // Active space capability gates management actions (UI only; the server is the
  // fortress). Space-level: a per-page edit override inside a view-only space would
  // widen beyond this. Per-page grants now exist (#163 / PermissionsDialog), but the
  // sidebar still gates on the SPACE capability; reflecting per-page capability here is
  // a separate enhancement (the server re-checks per page regardless).
  const currentSpace = spaces.find((s) => s.id === current);
  const canEdit = currentSpace?.capability === "edit" || currentSpace?.capability === "manage";
  const canManage = currentSpace?.capability === "manage";

  const createSpace = useCreateSpace();
  const renameSpace = useRenameSpace();
  const createPage = useCreatePage();
  const renamePage = useRenamePage();
  const deletePage = useDeletePage();
  const movePage = useMovePage();

  const [renaming, setRenaming] = useState<{ pageId: string; spaceId: string; title: string } | null>(null);
  const [renamingSpace, setRenamingSpace] = useState<{ id: string; name: string } | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  // Page deletion only — space deletion lives in Space settings (avoids accidental
  // destruction from the sidebar; #1).
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);

  const treeBox = useRef<HTMLDivElement>(null);
  const size = useSize(treeBox);

  const newPage = (parentId: string | null) => {
    if (!current) return;
    // A new page is created as a DRAFT and opens straight in the editor (?edit=1) —
    // it has no published content yet, so view mode would just be empty.
    createPage.mutate({ spaceId: current, parentId, title: "Untitled" }, { onSuccess: (p) => p && navigate(`/p/${p.id}?edit=1`) });
  };

  // DnD within the active space: reparent (drop onto a page) or reorder (drop at root).
  const onMove = ({ dragIds, parentId, index }: { dragIds: string[]; parentId: string | null; index: number }) => {
    const dragId = dragIds[0];
    if (!dragId?.startsWith("page:") || !current) return;
    const moved = pageById.get(dragId.slice(5));
    if (!moved) return;
    const parentPageId = parentId == null ? null : parentId.startsWith("page:") ? parentId.slice(5) : undefined;
    if (parentPageId === undefined) return;
    const siblings = pages.filter((p) => p.parentId === parentPageId && p.id !== moved.id).sort((a, b) => a.position - b.position);
    const afterId = index > 0 ? siblings[index - 1]?.id ?? null : null;
    movePage.mutate({ pageId: moved.id, fromSpaceId: moved.spaceId, toSpaceId: current, parentId: parentPageId, afterId });
  };

  // Page-row actions, consolidated into one "…" menu. Shown only when the active
  // space is editable (view-only ⇒ no edit actions; the server rejects regardless).
  const onRowAction = (value: string, d: Node) => {
    if (value === "subpage") newPage(d.pageId);
    else if (value === "share") setSharing(d.pageId);
    else if (value === "rename") setRenaming({ pageId: d.pageId, spaceId: d.spaceId, title: d.name });
    else if (value === "delete") setDeleting({ id: d.pageId, name: d.name });
  };
  // Route the row action through a ref so NodeRow's identity does NOT depend on it.
  // NodeRow is the react-arborist row renderer: if its identity changes on a Sidebar
  // re-render, react-arborist REMOUNTS every row — which detaches an open row menu's
  // trigger (Radix then closes the menu mid-click). Keeping NodeRow stable (memoised
  // on only render-affecting values) keeps tree rows — and any open menu — alive
  // across background re-renders.
  const onRowActionRef = useRef(onRowAction);
  onRowActionRef.current = onRowAction;

  const NodeRow = useCallback(({ node, style, dragHandle }: NodeRendererProps<Node>) => {
    const d = node.data;
    const selected = d.pageId === pageId;
    const hasChildren = (d.children?.length ?? 0) > 0;
    // #193 (rebuilt as ONE structure): react-arborist positions each row in a wrapper of exactly
    // rowHeight(32px) × 100%, and passes us `style` = the depth indent (paddingLeft) only + the
    // dragHandle ref. So the ONE correct layout is:
    //   OUTER  = h-full w-full → fills RA's 32px×full-width slot EXACTLY (box-border px-1 = a 4px edge
    //            inset inside that width, so the highlight never touches the scrollbar).
    //   INNER  = h-full w-full flex row = the highlight AND the click target. Because OUTER is now
    //            h-full, INNER's h-full resolves to the full 32px (the earlier bounce failed because
    //            OUTER had no height, so h-full/stretch collapsed to content height → the vertical gap).
    //   ROW    = chevron + icon + name(flex-1 min-w-0 truncate → ellipsis when narrow, full when wide)
    //            + badge/dot/actions(flex-none → never clipped; the name shrinks first).
    // Click area == highlight == the whole slot; no horizontal overflow; width-resize keeps all of it.
    const indent = typeof (style as { paddingLeft?: number }).paddingLeft === "number" ? (style as { paddingLeft: number }).paddingLeft : 0;
    return (
      <div
        ref={dragHandle}
        // #193 bounce: min-w-0 + overflow-hidden so this level of the chain also shrinks/clips (the RA
        // wrapper's forced min-width is overridden via rowClassName above; this keeps the chain complete
        // RA-wrapper → OUTER → INNER → ROW → name so the name truncates on width resize).
        className="group box-border h-full w-full min-w-0 overflow-hidden select-none px-1"
        data-testid="tree-page"
        data-selected={selected ? "" : undefined}
        onClick={() => navigate(`/p/${d.pageId}`)}
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
        <FileText size={14} className="flex-none text-fg-dim" />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{d.name || t("common.untitled")}</span>
        {/* 3-state: Draft (never published) / Unpublished changes / clean (nothing). */}
        {!d.published ? (
          <span className="mx-1 flex-none rounded border border-border px-[5px] py-0.5 text-[length:var(--text-xs)] leading-none text-fg-dim" data-testid="tree-draft-badge" title={t("sidebar.draftTitle")}>{t("sidebar.draft")}</span>
        ) : d.unpublished ? (
          <span className="mx-1 h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent)]" data-testid="unpublished-dot" title={t("sidebar.unpublished")} aria-label={t("sidebar.unpublished")} />
        ) : null}
        {canEdit && (
          <span className="flex gap-0.5 opacity-0 pointer-events-none transition-opacity duration-[120ms] group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100" onClick={(e) => e.stopPropagation()}>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger className="flex cursor-pointer rounded-sm p-0.5 text-fg-dim transition-colors duration-[120ms] hover:bg-border hover:text-foreground" aria-label={t("sidebar.pageActions")} data-testid="page-actions"><MoreHorizontal size={14} /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" data-testid="page-menu">
                <DropdownMenuItem onSelect={() => onRowActionRef.current("subpage", d)} data-testid="add-subpage"><FilePlus size={13} /> {t("sidebar.addSubpage")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRowActionRef.current("share", d)}><Share2 size={13} /> {t("sidebar.share")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRowActionRef.current("rename", d)}><Pencil size={13} /> {t("sidebar.rename")}</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onRowActionRef.current("delete", d)} data-danger="" variant="destructive"><Trash2 size={13} /> {t("sidebar.delete")}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        )}
       </div>
      </div>
    );
  }, [pageId, canEdit, t, navigate]);

  const headerBtn = "flex cursor-pointer rounded-sm p-1 text-fg-dim transition-colors duration-[120ms] hover:bg-panel-2 hover:text-foreground";

  // #193: drag the right edge to resize the sidebar. Width is the grid column --sidebar-w (AppShell),
  // clamped 180–480px and persisted to localStorage so it survives reloads. Restore on mount.
  useEffect(() => {
    const saved = localStorage.getItem("wks.sidebarW");
    if (saved) document.documentElement.style.setProperty("--sidebar-w", saved);
  }, []);
  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"), 10) || 260;
    const onMove = (ev: PointerEvent) => {
      const w = Math.max(180, Math.min(480, startW + (ev.clientX - startX)));
      document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      localStorage.setItem("wks.sidebarW", getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w").trim());
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden text-[length:var(--text-ui)]" data-testid="sidebar">
      {/* Space switcher — the space is a separate layer, not a tree root. */}
      <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 font-semibold text-foreground transition-colors duration-[120ms] hover:bg-panel-2" data-testid="space-switcher">
            {currentSpace && <SpaceIcon id={currentSpace.id} name={currentSpace.name} image={currentSpace.iconImageUrl} size={20} data-testid="space-icon" />}
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">{currentSpace?.name || t("sidebar.noSpace")}</span>
            <ChevronsUpDown size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-testid="space-menu">
            {spaces.map((s) => (
              <DropdownMenuItem key={s.id} onSelect={() => setActiveSpaceId(s.id)} data-testid="space-option">
                <SpaceIcon id={s.id} name={s.name} image={s.iconImageUrl} size={18} />
                {s.name || t("sidebar.untitledSpace")}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {currentSpace && canManage && <DropdownMenuItem onSelect={() => { if (currentSpace) setRenamingSpace({ id: currentSpace.id, name: currentSpace.name }); }}><Pencil size={13} /> {t("sidebar.renameSpace")}</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => setCreatingSpace(true)}><Plus size={13} /> {t("sidebar.newSpace")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {current && (canEdit || canManage) && (
          <div className="flex flex-none gap-0.5">
            {canEdit && <button type="button" className={headerBtn} title={t("sidebar.newPage")} aria-label={t("sidebar.newPage")} data-testid="new-page" onClick={() => newPage(null)}><FilePlus size={15} /></button>}
            {canManage && <button type="button" className={headerBtn} title={t("sidebar.spaceSettings")} aria-label={t("sidebar.spaceSettings")} data-testid="space-settings-open" onClick={() => current && navigate(`/spaces/${current}/settings`)}><Settings size={15} /></button>}
          </div>
        )}
      </div>

      {spacesQ.isLoading ? (
        <div className="p-3 text-fg-dim">{t("common.loading")}</div>
      ) : spacesQ.isError ? (
        <div className="p-3 text-fg-dim">{t("sidebar.loadFailed")} <button type="button" className="cursor-pointer text-[var(--accent)]" onClick={() => spacesQ.refetch()}>{t("sidebar.retry")}</button></div>
      ) : spaces.length === 0 ? (
        <div className="p-3 text-fg-dim">{t("sidebar.noSpaces")}</div>
      ) : pages.length === 0 ? (
        <div className="p-3 text-fg-dim">{t("sidebar.noPages")}</div>
      ) : (
        <div ref={treeBox} className="min-h-0 min-w-0 flex-1">
          <Tree<Node>
            className="!overflow-x-hidden"
            // #193 bounce: react-arborist forces each row wrapper to `min-width: <scrollable width>`
            // (row-container.js — its #10 highlight-to-edge for horizontally-scrolled nested rows). That
            // INLINE min-width is the broken link in the shrink chain: it pins every row to content width,
            // so a long name never shrinks and `truncate` can't fire (it's clipped without an ellipsis).
            // We hide horizontal scroll (above), so that min-width is unneeded — override it to 0 with
            // `!min-w-0` (min-width:0 !important beats the inline style). Now the row = viewport width and
            // the name's flex-1 min-w-0 truncate engages on width resize.
            rowClassName="!min-w-0"
            data={data}
            idAccessor="id"
            childrenAccessor="children"
            openByDefault={false}
            width={size.width || 260}
            height={size.height || 400}
            indent={14}
            rowHeight={32}
            selection={pageId ? `page:${pageId}` : undefined}
            disableMultiSelection
            disableDrop={({ parentNode, dragNodes }) => {
              const drag = dragNodes[0]?.data as Node | undefined;
              if (!drag) return true;
              // Block dropping a page onto itself or a descendant (cycle). Root drops
              // (parentNode null) and page parents within the active space are fine.
              if (parentNode && (parentNode.data as Node).pageId) {
                let cur: Page | undefined = pageById.get((parentNode.data as Node).pageId);
                while (cur) {
                  if (cur.id === drag.pageId) return true;
                  cur = cur.parentId ? pageById.get(cur.parentId) : undefined;
                }
              }
              return false;
            }}
            onMove={onMove}
            onActivate={(n: NodeApi<Node>) => navigate(`/p/${n.data.pageId}`)}
          >
            {NodeRow}
          </Tree>
        </div>
      )}

      <RenameDialog
        open={renaming !== null}
        initial={renaming?.title ?? ""}
        onClose={() => setRenaming(null)}
        onSubmit={(title) => { if (renaming) renamePage.mutate({ ...renaming, title }); setRenaming(null); }}
      />
      <ConfirmDialog
        open={deleting !== null}
        message={t("sidebar.deletePageConfirm", { name: deleting?.name ?? "" })}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deletePage.mutate({ pageId: deleting.id, spaceId: current! });
          setDeleting(null);
        }}
      />
      <RenameDialog
        open={renamingSpace !== null}
        initial={renamingSpace?.name ?? ""}
        title={t("sidebar.renameSpace")}
        label={t("sidebar.spaceName")}
        onClose={() => setRenamingSpace(null)}
        onSubmit={(name) => { if (renamingSpace) renameSpace.mutate({ spaceId: renamingSpace.id, name }); setRenamingSpace(null); }}
      />
      <RenameDialog
        open={creatingSpace}
        initial=""
        title={t("sidebar.newSpace")}
        label={t("sidebar.spaceName")}
        submitLabel={t("sidebar.createSpace")}
        onClose={() => setCreatingSpace(false)}
        onSubmit={(name) => { createSpace.mutate(name, { onSuccess: (s) => s && setActiveSpaceId(s.id) }); setCreatingSpace(false); }}
      />
      <ShareDialog pageId={sharing} onClose={() => setSharing(null)} />
      {/* #193: drag-to-resize handle on the sidebar's right edge. */}
      <div
        onPointerDown={onResizeStart}
        data-testid="sidebar-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        className="absolute inset-y-0 right-0 z-10 w-1 cursor-col-resize transition-colors duration-[120ms] hover:bg-[color-mix(in_srgb,var(--accent)_50%,transparent)]"
      />
    </div>
  );
}
