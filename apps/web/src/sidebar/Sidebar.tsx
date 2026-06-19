import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { Tree, type NodeApi, type NodeRendererProps } from "react-arborist";
import { ChevronRight, FilePlus, FileText, Folder, FolderPlus, Pencil, Share2, Trash2 } from "lucide-react";
import {
  useSpaces,
  useCreateSpace,
  useCreatePage,
  useRenamePage,
  useDeletePage,
  useDeleteSpace,
  useMovePage,
  type Page,
} from "../data/queries";
import { apiFetch } from "../data/apiClient";
import { useSession } from "../session/SessionProvider";
import { RenameDialog, ConfirmDialog } from "../ui/dialogs";
import { ShareDialog } from "../ui/ShareDialog";
import styles from "./Sidebar.module.css";

// Tree node: spaces are roots, pages nest under their space/parent. Pages are
// always "internal" (children: []) so they accept drops (nest-under). id is
// namespaced so selection/DnD can tell spaces from pages.
interface Node {
  id: string;
  name: string;
  kind: "space" | "page";
  spaceId: string;
  pageId?: string;
  children?: Node[];
}

function buildPageNodes(pages: Page[], parentId: string | null): Node[] {
  return pages
    .filter((p) => p.parentId === parentId)
    .sort((a, b) => a.position - b.position)
    .map((p) => ({
      id: `page:${p.id}`,
      name: p.title || "Untitled",
      kind: "page" as const,
      spaceId: p.spaceId,
      pageId: p.id,
      children: buildPageNodes(pages, p.id),
    }));
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
  const { token, tenantId } = useSession();
  const navigate = useNavigate();
  const { pageId } = useParams<{ pageId: string }>();

  const spacesQ = useSpaces();
  const spaces = spacesQ.data ?? [];
  const pageQs = useQueries({
    queries: spaces.map((s) => ({
      queryKey: ["pages", s.id],
      queryFn: () => apiFetch<Page[]>(`/spaces/${s.id}/pages`, token).then((r) => r ?? []),
      staleTime: 30_000,
    })),
  });
  const pagesBySpace: Record<string, Page[]> = {};
  const pageById = new Map<string, Page>();
  spaces.forEach((s, i) => {
    const ps = (pageQs[i]?.data as Page[] | undefined) ?? [];
    pagesBySpace[s.id] = ps;
    ps.forEach((p) => pageById.set(p.id, p));
  });

  const data: Node[] = useMemo(
    () =>
      spaces.map((s) => ({
        id: `space:${s.id}`,
        name: s.name || "Untitled space",
        kind: "space" as const,
        spaceId: s.id,
        children: buildPageNodes(pagesBySpace[s.id] ?? [], null),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(spaces), JSON.stringify(pagesBySpace)],
  );

  const createSpace = useCreateSpace();
  const createPage = useCreatePage();
  const renamePage = useRenamePage();
  const deletePage = useDeletePage();
  const deleteSpace = useDeleteSpace();
  const movePage = useMovePage();

  const [renaming, setRenaming] = useState<{ pageId: string; spaceId: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<
    | { kind: "page"; id: string; spaceId: string; name: string }
    | { kind: "space"; id: string; name: string }
    | null
  >(null);
  const [sharing, setSharing] = useState<string | null>(null);

  const treeBox = useRef<HTMLDivElement>(null);
  const size = useSize(treeBox);

  // DnD: only pages move, only WITHIN their space (cross-space = phase 3b ②).
  const onMove = ({ dragIds, parentId, index }: { dragIds: string[]; parentId: string | null; index: number }) => {
    const dragId = dragIds[0];
    if (!dragId?.startsWith("page:")) return;
    const moved = pageById.get(dragId.slice(5));
    if (!moved || parentId == null) return;
    let targetSpaceId: string;
    let parentPageId: string | null;
    if (parentId.startsWith("space:")) {
      targetSpaceId = parentId.slice(6);
      parentPageId = null;
    } else {
      const pp = pageById.get(parentId.slice(5));
      if (!pp) return;
      targetSpaceId = pp.spaceId;
      parentPageId = pp.id;
    }
    if (targetSpaceId !== moved.spaceId) return; // cross-space deferred to ②
    const siblings = (pagesBySpace[targetSpaceId] ?? [])
      .filter((p) => p.parentId === parentPageId && p.id !== moved.id)
      .sort((a, b) => a.position - b.position);
    const afterId = index > 0 ? siblings[index - 1]?.id ?? null : null;
    movePage.mutate({ pageId: moved.id, spaceId: moved.spaceId, parentId: parentPageId, afterId });
  };

  const NodeRow = ({ node, style, dragHandle }: NodeRendererProps<Node>) => {
    const d = node.data;
    const isPage = d.kind === "page";
    const selected = isPage && d.pageId === pageId;
    const hasChildren = (d.children?.length ?? 0) > 0;
    return (
      <div
        ref={dragHandle}
        style={style}
        className={`${styles.row} ${selected ? styles.selected : ""}`}
        data-testid={isPage ? "tree-page" : "tree-space"}
        data-selected={selected ? "" : undefined}
        onClick={() => {
          if (isPage) navigate(`/p/${d.pageId}`);
          else node.toggle();
        }}
      >
        <span
          className={styles.indicator}
          onClick={(e) => { e.stopPropagation(); node.toggle(); }}
        >
          {hasChildren ? <ChevronRight size={14} className={node.isOpen ? styles.caretOpen : ""} /> : <span className={styles.caretSpace} />}
        </span>
        {isPage ? <FileText size={14} className={styles.fileIcon} /> : <Folder size={14} className={styles.fileIcon} />}
        <span className={styles.name}>{d.name}</span>
        <span className={styles.actions}>
          {isPage ? (
            <>
              <button type="button" title="Share" aria-label="Share page" onClick={(e) => { e.stopPropagation(); setSharing(d.pageId!); }}><Share2 size={14} /></button>
              <button type="button" title="Rename" aria-label="Rename page" onClick={(e) => { e.stopPropagation(); setRenaming({ pageId: d.pageId!, spaceId: d.spaceId, title: d.name }); }}><Pencil size={14} /></button>
              <button type="button" title="Delete" aria-label="Delete page" onClick={(e) => { e.stopPropagation(); setDeleting({ kind: "page", id: d.pageId!, spaceId: d.spaceId, name: d.name }); }}><Trash2 size={14} /></button>
            </>
          ) : (
            <>
              <button type="button" title="New page" aria-label="New page" onClick={(e) => { e.stopPropagation(); createPage.mutate({ spaceId: d.spaceId, title: "Untitled" }, { onSuccess: (p) => p && navigate(`/p/${p.id}`) }); }}><FilePlus size={14} /></button>
              <button type="button" title="Delete space" aria-label="Delete space" onClick={(e) => { e.stopPropagation(); setDeleting({ kind: "space", id: d.spaceId, name: d.name }); }}><Trash2 size={14} /></button>
            </>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className={styles.sidebar} data-testid="sidebar">
      <div className={styles.header}>
        <span className={styles.title}>Spaces</span>
        <button type="button" title="New space" aria-label="New space" onClick={() => createSpace.mutate("Untitled space")}>
          <FolderPlus size={15} />
        </button>
      </div>

      {spacesQ.isLoading ? (
        <div className={styles.state}>Loading…</div>
      ) : spacesQ.isError ? (
        <div className={styles.state}>Failed to load. <button type="button" onClick={() => spacesQ.refetch()}>Retry</button></div>
      ) : spaces.length === 0 ? (
        <div className={styles.state}>No spaces yet — create one above.</div>
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
            disableDrag={(d) => (d as Node).kind === "space"}
            disableDrop={({ parentNode, dragNodes }) => {
              if (!parentNode) return true; // no top-level (space-less) drops
              const drag = dragNodes[0]?.data as Node | undefined;
              return !drag || (parentNode.data as Node).spaceId !== drag.spaceId; // same-space only (①)
            }}
            onMove={onMove}
            onActivate={(n: NodeApi<Node>) => { if (n.data.kind === "page") navigate(`/p/${n.data.pageId}`); }}
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
          if (deleting?.kind === "page") deletePage.mutate({ pageId: deleting.id, spaceId: deleting.spaceId });
          else if (deleting?.kind === "space") deleteSpace.mutate(deleting.id);
          setDeleting(null);
        }}
      />
      <ShareDialog pageId={sharing} onClose={() => setSharing(null)} />
    </div>
  );
}
