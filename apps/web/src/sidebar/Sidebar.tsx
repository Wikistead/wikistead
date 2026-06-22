import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import { Menu } from "@ark-ui/react/menu";
import { Portal } from "@ark-ui/react/portal";
import { ChevronRight, ChevronsUpDown, FilePlus, FileText, MoreHorizontal, Pencil, Plus, Share2, Trash2 } from "lucide-react";
import {
  useSpaces,
  useCreateSpace,
  useRenameSpace,
  useCreatePage,
  useRenamePage,
  useDeletePage,
  useDeleteSpace,
  useMovePage,
  type Page,
} from "../data/queries";
import { apiFetch } from "../data/apiClient";
import { useSession } from "../session/SessionProvider";
import { useActiveSpace } from "../app/ActiveSpace";
import { RenameDialog, ConfirmDialog } from "../ui/dialogs";
import { ShareDialog } from "../ui/ShareDialog";
import styles from "./Sidebar.module.css";

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
    .map((p) => ({ id: `page:${p.id}`, name: p.title || "Untitled", pageId: p.id, spaceId: p.spaceId, published: p.published ?? false, unpublished: p.hasUnpublishedChanges ?? false, children: buildPageNodes(pages, p.id) }));
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
  // widen beyond this — not possible until per-page grants exist (Phase 4 E; TODO).
  const currentSpace = spaces.find((s) => s.id === current);
  const canEdit = currentSpace?.capability === "edit" || currentSpace?.capability === "manage";
  const canManage = currentSpace?.capability === "manage";

  const createSpace = useCreateSpace();
  const renameSpace = useRenameSpace();
  const createPage = useCreatePage();
  const renamePage = useRenamePage();
  const deletePage = useDeletePage();
  const deleteSpace = useDeleteSpace();
  const movePage = useMovePage();

  const [renaming, setRenaming] = useState<{ pageId: string; spaceId: string; title: string } | null>(null);
  const [renamingSpace, setRenamingSpace] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ kind: "page"; id: string; name: string } | { kind: "space"; id: string; name: string } | null>(null);
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
    else if (value === "delete") setDeleting({ kind: "page", id: d.pageId, name: d.name });
  };

  const NodeRow = ({ node, style, dragHandle }: NodeRendererProps<Node>) => {
    const d = node.data;
    const selected = d.pageId === pageId;
    const hasChildren = (d.children?.length ?? 0) > 0;
    return (
      <div
        ref={dragHandle}
        style={style}
        className={`${styles.row} ${selected ? styles.selected : ""}`}
        data-testid="tree-page"
        data-selected={selected ? "" : undefined}
        onClick={() => navigate(`/p/${d.pageId}`)}
      >
        <span className={styles.indicator} onClick={(e) => { e.stopPropagation(); node.toggle(); }}>
          {hasChildren ? <ChevronRight size={14} className={node.isOpen ? styles.caretOpen : ""} /> : <span className={styles.caretSpace} />}
        </span>
        <FileText size={14} className={styles.fileIcon} />
        <span className={styles.name}>{d.name}</span>
        {/* 3-state: Draft (never published) / Unpublished changes / clean (nothing). */}
        {!d.published ? (
          <span className={styles.draftBadge} data-testid="tree-draft-badge" title="Draft (not published)">Draft</span>
        ) : d.unpublished ? (
          <span className={styles.unpublishedDot} data-testid="unpublished-dot" title="Unpublished changes" aria-label="Unpublished changes" />
        ) : null}
        {canEdit && (
          <span className={styles.actions} onClick={(e) => e.stopPropagation()}>
            <Menu.Root onSelect={(m) => onRowAction(m.value, d)}>
              <Menu.Trigger className={styles.rowMenuBtn} aria-label="Page actions" data-testid="page-actions"><MoreHorizontal size={14} /></Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content className={styles.menu} data-testid="page-menu">
                    <Menu.Item value="subpage" className={styles.menuItem} data-testid="add-subpage"><FilePlus size={13} /> Add sub-page</Menu.Item>
                    <Menu.Item value="share" className={styles.menuItem}><Share2 size={13} /> Share</Menu.Item>
                    <Menu.Item value="rename" className={styles.menuItem}><Pencil size={13} /> Rename</Menu.Item>
                    <Menu.Item value="delete" className={styles.menuItem}><Trash2 size={13} /> Delete</Menu.Item>
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </span>
        )}
      </div>
    );
  };

  return (
    <div className={styles.sidebar} data-testid="sidebar">
      {/* Space switcher — the space is a separate layer, not a tree root. */}
      <div className={styles.header}>
        <Menu.Root
          onSelect={(d) => {
            if (d.value === "__new__") createSpace.mutate("Untitled space", { onSuccess: (s) => s && setActiveSpaceId(s.id) });
            else if (d.value === "__rename__") { if (currentSpace) setRenamingSpace({ id: currentSpace.id, name: currentSpace.name }); }
            else setActiveSpaceId(d.value);
          }}
        >
          <Menu.Trigger className={styles.switcher} data-testid="space-switcher">
            <span className={styles.switcherName}>{currentSpace?.name || "No space"}</span>
            <ChevronsUpDown size={14} />
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content className={styles.menu} data-testid="space-menu">
                {spaces.map((s) => (
                  <Menu.Item key={s.id} value={s.id} className={styles.menuItem} data-testid="space-option">{s.name || "Untitled space"}</Menu.Item>
                ))}
                <Menu.Separator className={styles.menuSep} />
                {currentSpace && canManage && <Menu.Item value="__rename__" className={styles.menuItem}><Pencil size={13} /> Rename space</Menu.Item>}
                <Menu.Item value="__new__" className={styles.menuItem}><Plus size={13} /> New space</Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
        {current && (canEdit || canManage) && (
          <div className={styles.headerActions}>
            {canEdit && <button type="button" title="New page" aria-label="New page" data-testid="new-page" onClick={() => newPage(null)}><FilePlus size={15} /></button>}
            {canManage && <button type="button" title="Delete space" aria-label="Delete space" onClick={() => currentSpace && setDeleting({ kind: "space", id: current, name: currentSpace.name })}><Trash2 size={15} /></button>}
          </div>
        )}
      </div>

      {spacesQ.isLoading ? (
        <div className={styles.state}>Loading…</div>
      ) : spacesQ.isError ? (
        <div className={styles.state}>Failed to load. <button type="button" onClick={() => spacesQ.refetch()}>Retry</button></div>
      ) : spaces.length === 0 ? (
        <div className={styles.state}>No spaces yet — create one above.</div>
      ) : pages.length === 0 ? (
        <div className={styles.state}>No pages yet — add one above.</div>
      ) : (
        <div ref={treeBox} className={styles.treeBox}>
          <Tree<Node>
            data={data}
            idAccessor="id"
            childrenAccessor="children"
            openByDefault={false}
            width={size.width || 260}
            height={size.height || 400}
            indent={14}
            rowHeight={28}
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
        message={deleting?.kind === "space" ? `Delete space "${deleting.name}" and all its pages?` : `Delete page "${deleting?.name}" and its sub-pages?`}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting?.kind === "page") deletePage.mutate({ pageId: deleting.id, spaceId: current! });
          else if (deleting?.kind === "space") { deleteSpace.mutate(deleting.id); setActiveSpaceId(spaces.find((s) => s.id !== deleting.id)?.id ?? null); }
          setDeleting(null);
        }}
      />
      <RenameDialog
        open={renamingSpace !== null}
        initial={renamingSpace?.name ?? ""}
        onClose={() => setRenamingSpace(null)}
        onSubmit={(name) => { if (renamingSpace) renameSpace.mutate({ spaceId: renamingSpace.id, name }); setRenamingSpace(null); }}
      />
      <ShareDialog pageId={sharing} onClose={() => setSharing(null)} />
    </div>
  );
}
