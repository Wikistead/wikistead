import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FileText, Home } from "lucide-react";
import type { Page } from "../data/queries";
import { SpaceIcon } from "../ui/SpaceIcon";
import { NewPageButton } from "../sidebar/NewPageButton";
import { SidebarTreeSkeleton, useDelayedFlag } from "../ui/Skeleton"; // #457 loading vs empty

// #245 / ADR-112: the guest reader-chrome sidebar. A space share-link guest browses the linked space's
// page tree exactly like a member — but this is a READ-ONLY, member-chrome-free tree. It renders NO space
// switcher, settings, new/rename/delete affordances, and NO member editing metadata (unpublished-changes
// dots, draft/lock badges): those are member chrome (Decision 2 + the review refinement). The rows
// come from GET /spaces/:id/pages, which is guest-capable and per-page FGA-gated on the share_link
// principal, so restricted / unpublished / (post-#244) private pages appear in neither the tree nor as
// titles. The component is fed a page list synthesised from the share token's single space — it never
// calls the member-only GET /spaces (Decision 0).
interface TreeNode {
  id: string;
  title: string;
  children: TreeNode[];
}

function subtree(pages: Page[], parentId: string): TreeNode[] {
  return pages
    .filter((p) => (p.parentId ?? null) === parentId)
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ id: p.id, title: p.title, children: subtree(pages, p.id) }));
}

// Build the guest tree from the FGA-filtered page set. A page is a ROOT when it has no parent OR its
// parent is NOT in the visible set — the latter re-roots a viewable child whose parent the guest cannot
// see, so a permitted page is never orphaned out of the tree (the parent was already existence-hidden
// server-side; this is a UX completeness fix, not an authz change — the set is authoritative).
function buildTree(pages: Page[]): TreeNode[] {
  const present = new Set(pages.map((p) => p.id));
  return pages
    .filter((p) => p.parentId == null || !present.has(p.parentId))
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ id: p.id, title: p.title, children: subtree(pages, p.id) }));
}

// onCreate (#274 / ADR-135): present ONLY for an EDIT-capability space link — the one write
// affordance in the guest chrome, and it is the MEMBER new-page control (shared NewPageButton: click →
// blank "Untitled" page immediately → the editor; naming happens there), not a guest-specific flow. The
// template ▾ stays member-only (template non-leak). The server stays the fortress: the route re-checks
// FGA `edit` on the space and applies the created-page cap regardless of this UI.
// #457 `loading` distinguishes "the tree hasn't arrived" from "the space has no pages" — the
// same three-state discipline the member sidebar got in #492 (#500 added the error/retry leg). The
// skeleton is delay-gated so a fast tree fetch never flashes it.
// `error` is required, not optional: the caller owns the fetch (#500), and an omitted prop here would
// silently read as "not erroring" — the exact error-reads-as-empty shape #500 exists to prevent.
export function GuestSidebar({ pages, loading = false, space, openId, onOpen, onCreate, homePageId, error, onRetry, truncated = false }: { pages: Page[]; loading?: boolean; space?: { name: string; iconImageUrl: string | null }; openId: string | null; onOpen: (id: string) => void; onCreate?: () => Promise<void>; homePageId?: string | null; error: boolean; onRetry?: () => void; truncated?: boolean }) {
  const { t } = useTranslation();
  const showSkeleton = useDelayedFlag(loading);
  const tree = buildTree(pages);
  const [busy, setBusy] = useState(false);
  // #274 (3): keep the ACTIVE row visible — after creates a page the shell navigates to it,
  // but in a long tree the new row (which only renders after the pages refetch — hence `pages` in the
  // deps) could sit below the fold. nearest-block scrolling, so ordinary clicks never jump the list.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!openId) return;
    navRef.current?.querySelector(`[data-page-id="${openId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [openId, pages]);
  const create = async () => {
    if (!onCreate || busy) return;
    setBusy(true);
    try {
      await onCreate();
    } finally {
      setBusy(false);
    }
  };
  // #270: the header shows the real space name + icon (member-parity), falling back to the generic label
  // only when the space info hasn't loaded. The icon uses the public /spaces/:id/icon-image (guest-readable),
  // and SpaceIcon falls back to an initials chip if there is no uploaded image.
  const heading = space?.name || t("share.spaceTitle");
  return (
    <nav ref={navRef} className="flex h-full flex-col gap-0.5 overflow-auto p-2 text-[length:var(--text-ui)]" data-testid="guest-sidebar" aria-label={heading}>
      <div className="flex items-center gap-1.5 px-1 pb-1.5 font-semibold text-foreground" data-testid="guest-space-heading">
        {space ? <SpaceIcon id={space.name} name={space.name} image={space.iconImageUrl} size={18} /> : null}
        <span className="truncate">{heading}</span>
        {/* member-parity at the header's right edge, exactly like the member sidebar header row. */}
        {onCreate && <span className="ml-auto flex flex-none"><NewPageButton onClick={() => void create()} disabled={busy} /></span>}
      </div>
      {/* #364 ①: the fixed Home entry, member-parity (§6b) — shown only when the server exposed a
          VIEW-GATED homePageId (an unpublished/unviewable home is null = no entry, existence-hidden).
          The label is the viewer-language space-home phrase (a UI i18n label, never stored). */}
      {homePageId && (
        <div
          className={`mb-1 flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border-b border-border px-2 pb-1 transition-colors duration-[120ms] ${openId === homePageId ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel-3))] font-medium" : "hover:bg-panel-2"}`}
          data-testid="guest-sidebar-home"
          onClick={() => onOpen(homePageId)}
        >
          <Home size={14} className="flex-none text-fg-dim" />
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{space ? t("spaceHome.title", { name: space.name }) : t("sidebar.home")}</span>
        </div>
      )}
      {/* #500: a failed tree fetch is an ERROR, never "this space is empty" — the swallow used to read as
          "no pages" and derailed real-reviews. The wording is generic (no content disclosure, so
          existence-hiding is untouched) and retry re-runs the same guest-gated fetch. */}
      {error ? (
        <div className="flex flex-col items-start gap-1.5 px-1 py-2" data-testid="guest-tree-error">
          <span className="text-fg-dim">{t("share.treeError")}</span>
          {onRetry && (
            <button type="button" className="cursor-pointer rounded-md border border-border px-2 py-0.5 text-foreground hover:bg-panel-2" data-testid="guest-tree-retry" onClick={onRetry}>
              {t("share.treeRetry")}
            </button>
          )}
        </div>
      ) : loading ? (
        // #457 loading, not empty — the empty wording below must never show for a tree that
        // simply hasn't arrived. The skeleton itself is delay-gated (a fast fetch renders nothing).
        showSkeleton ? <SidebarTreeSkeleton testid="guest-sidebar-skeleton" /> : null
      ) : tree.length === 0 ? (
        <div className="px-1 py-2 text-fg-dim" data-testid="guest-sidebar-empty">{t("share.spaceEmpty")}</div>
      ) : (
        tree.map((n) => <GuestNode key={n.id} node={n} depth={0} openId={openId} onOpen={onOpen} />)
      )}
      {/* #623 / ADR-220 §6.2: the cap is LOUD. This list is drawn unvirtualised and fully expanded, so
          a tree the server had to cut has to say so — a silent cut looks like a complete tree that is
          simply missing pages, and the reader has no way to tell. */}
      {truncated && (
        <p className="mt-2 px-1 text-[0.85em] text-fg-dim" data-testid="guest-tree-truncated">
          {t("toast.treeTruncated")}
        </p>
      )}
    </nav>
  );
}

function GuestNode({ node, depth, openId, onOpen }: { node: TreeNode; depth: number; openId: string | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      {/* #274 (2): the SELECTED row uses the member accent-mix highlight (PageTree.tsx),
          not the grey hover wash — same look for the same state on both shells. */}
      <div
        className={`flex items-center gap-1 rounded ${openId === node.id ? "bg-[color-mix(in_srgb,var(--accent)_12%,var(--panel-3))] font-medium" : "hover:bg-panel-2"}`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {hasChildren ? (
          <button type="button" className="flex-none rounded p-0.5 text-fg-dim hover:text-foreground" onClick={() => setExpanded((e) => !e)} aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}>
            <ChevronRight size={12} className={expanded ? "rotate-90 transition-transform" : "transition-transform"} />
          </button>
        ) : (
          <span className="w-[18px] flex-none" />
        )}
        <button
          type="button"
          data-testid="guest-tree-page"
          data-page-id={node.id}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1 pr-1 text-left"
          onClick={() => onOpen(node.id)}
        >
          <FileText size={13} className="flex-none text-fg-dim" />
          <span className="truncate">{node.title || t("common.untitled")}</span>
        </button>
      </div>
      {hasChildren && expanded && node.children.map((c) => <GuestNode key={c.id} node={c} depth={depth + 1} openId={openId} onOpen={onOpen} />)}
    </div>
  );
}
