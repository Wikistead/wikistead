import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueries } from "@tanstack/react-query";
import { TreeView, createTreeCollection } from "@ark-ui/react/tree-view";
import { ChevronRight, FilePlus, FileText, FolderPlus, Pencil, Trash2 } from "lucide-react";
import {
  useSpaces,
  useCreateSpace,
  useCreatePage,
  useRenamePage,
  useDeletePage,
  useDeleteSpace,
  type Page,
} from "../data/queries";
import { apiFetch } from "../data/apiClient";
import { useSession } from "../session/SessionProvider";
import { RenameDialog, ConfirmDialog } from "../ui/dialogs";
import styles from "./Sidebar.module.css";

// Node value namespaces space vs page so selection/expansion can tell them apart
// and selecting a page can drive the router.
interface Node {
  id: string;
  name: string;
  kind: "space" | "page";
  spaceId?: string;
  children?: Node[];
}
const valueOf = (n: Node) => `${n.kind}:${n.id}`;

export function Sidebar() {
  const { token, tenantId } = useSession();
  const navigate = useNavigate();
  const { pageId } = useParams<{ pageId: string }>();

  const spacesQ = useSpaces();
  const spaces = spacesQ.data ?? [];

  // Pages per space. The whole tree is built upfront so Ark's keyboard nav /
  // typeahead work across it. (3b will switch to lazy load + nesting.)
  const pageQs = useQueries({
    queries: spaces.map((s) => ({
      queryKey: ["pages", s.id],
      queryFn: () => apiFetch<Page[]>(`/spaces/${s.id}/pages`, token).then((r) => r ?? []),
      staleTime: 30_000,
    })),
  });
  const pagesBySpace: Record<string, Page[]> = {};
  spaces.forEach((s, i) => {
    pagesBySpace[s.id] = (pageQs[i]?.data as Page[] | undefined) ?? [];
  });

  const collection = useMemo(() => {
    const root: Node = {
      id: "ROOT",
      name: "",
      kind: "space",
      children: spaces.map((s) => ({
        id: s.id,
        name: s.name || "Untitled space",
        kind: "space" as const,
        children: (pagesBySpace[s.id] ?? []).map((p) => ({
          id: p.id,
          name: p.title || "Untitled",
          kind: "page" as const,
          spaceId: s.id,
        })),
      })),
    };
    return createTreeCollection<Node>({
      rootNode: root,
      nodeToValue: valueOf,
      nodeToString: (n) => n.name,
    });
    // Rebuild only when the underlying data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(spaces), JSON.stringify(pagesBySpace)]);

  // Selection follows the route; selecting a page node navigates.
  const selectedValue = pageId ? [`page:${pageId}`] : [];

  // Expansion persisted per tenant.
  const expKey = `wikistead:tree-expanded:${tenantId}`;
  const [expandedValue, setExpandedValue] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(expKey) ?? "[]");
    } catch {
      return [];
    }
  });

  const createSpace = useCreateSpace();
  const createPage = useCreatePage();
  const renamePage = useRenamePage();
  const deletePage = useDeletePage();
  const deleteSpace = useDeleteSpace();

  const [renaming, setRenaming] = useState<{ pageId: string; spaceId: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<
    | { kind: "page"; id: string; spaceId: string; name: string }
    | { kind: "space"; id: string; name: string }
    | null
  >(null);

  const renderNode = (node: Node, indexPath: number[]) => (
    <TreeView.NodeProvider key={valueOf(node)} node={node} indexPath={indexPath}>
      {node.kind === "space" ? (
        <TreeView.Branch>
          <TreeView.BranchControl className={styles.row}>
            <TreeView.BranchIndicator className={styles.indicator}>
              <ChevronRight size={14} />
            </TreeView.BranchIndicator>
            <TreeView.BranchText className={styles.name}>{node.name}</TreeView.BranchText>
            <span className={styles.actions}>
              <button
                type="button"
                title="New page"
                aria-label="New page"
                onClick={(e) => {
                  e.stopPropagation();
                  createPage.mutate(
                    { spaceId: node.id, title: "Untitled" },
                    { onSuccess: (p) => p && navigate(`/p/${p.id}`) },
                  );
                }}
              >
                <FilePlus size={14} />
              </button>
              <button
                type="button"
                title="Delete space"
                aria-label="Delete space"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleting({ kind: "space", id: node.id, name: node.name });
                }}
              >
                <Trash2 size={14} />
              </button>
            </span>
          </TreeView.BranchControl>
          <TreeView.BranchContent>
            {(node.children ?? []).map((c, i) => renderNode(c, [...indexPath, i]))}
          </TreeView.BranchContent>
        </TreeView.Branch>
      ) : (
        <TreeView.Item className={styles.row}>
          <FileText size={14} className={styles.fileIcon} />
          <TreeView.ItemText className={styles.name}>{node.name}</TreeView.ItemText>
          <span className={styles.actions}>
            <button
              type="button"
              title="Rename"
              aria-label="Rename page"
              onClick={(e) => {
                e.stopPropagation();
                setRenaming({ pageId: node.id, spaceId: node.spaceId!, title: node.name });
              }}
            >
              <Pencil size={14} />
            </button>
            <button
              type="button"
              title="Delete"
              aria-label="Delete page"
              onClick={(e) => {
                e.stopPropagation();
                setDeleting({ kind: "page", id: node.id, spaceId: node.spaceId!, name: node.name });
              }}
            >
              <Trash2 size={14} />
            </button>
          </span>
        </TreeView.Item>
      )}
    </TreeView.NodeProvider>
  );

  return (
    <div className={styles.sidebar} data-testid="sidebar">
      <div className={styles.header}>
        <span className={styles.title}>Spaces</span>
        <button
          type="button"
          title="New space"
          aria-label="New space"
          onClick={() => createSpace.mutate("Untitled space")}
        >
          <FolderPlus size={15} />
        </button>
      </div>

      {spacesQ.isLoading ? (
        <div className={styles.state}>Loading…</div>
      ) : spacesQ.isError ? (
        <div className={styles.state}>
          Failed to load.{" "}
          <button type="button" onClick={() => spacesQ.refetch()}>
            Retry
          </button>
        </div>
      ) : spaces.length === 0 ? (
        <div className={styles.state}>No spaces yet — create one above.</div>
      ) : (
        <TreeView.Root
          className={styles.tree}
          collection={collection}
          selectionMode="single"
          selectedValue={selectedValue}
          expandedValue={expandedValue}
          onExpandedChange={(d) => {
            setExpandedValue(d.expandedValue);
            try {
              localStorage.setItem(expKey, JSON.stringify(d.expandedValue));
            } catch {
              /* private mode */
            }
          }}
          onSelectionChange={(d) => {
            const v = d.selectedValue[0];
            if (v?.startsWith("page:")) navigate(`/p/${v.slice("page:".length)}`);
          }}
        >
          <TreeView.Tree>
            {collection.rootNode.children?.map((node, i) => renderNode(node as Node, [i]))}
          </TreeView.Tree>
        </TreeView.Root>
      )}

      <RenameDialog
        open={renaming !== null}
        initial={renaming?.title ?? ""}
        onClose={() => setRenaming(null)}
        onSubmit={(title) => {
          if (renaming) renamePage.mutate({ ...renaming, title });
          setRenaming(null);
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        message={
          deleting?.kind === "space"
            ? `Delete space "${deleting.name}" and all its pages?`
            : `Delete page "${deleting?.name}"?`
        }
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting?.kind === "page") deletePage.mutate({ pageId: deleting.id, spaceId: deleting.spaceId });
          else if (deleting?.kind === "space") deleteSpace.mutate(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
