import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FileText, Home } from "lucide-react";
import type { Page } from "../data/queries";
import { SpaceIcon } from "../ui/SpaceIcon";
import { NewPageButton } from "../sidebar/NewPageButton";
import { MoreRow } from "../sidebar/PageTree"; // #1149 (ruling/#903): shared with the member tree's own auto-loading continuation row, not a forked mechanism
import { SidebarTreeSkeleton, useDelayedFlag } from "../ui/Skeleton"; // #457 loading vs empty

// #245 / ADR-112: the guest reader-chrome sidebar. A space share-link guest browses the linked space's
// page tree exactly like a member — but this is a READ-ONLY, member-chrome-free tree. It renders NO space
// switcher, settings, new/rename/delete affordances, and NO member editing metadata (unpublished-changes
// dots, draft/lock badges): those are member chrome (Decision 2 + the review refinement). The rows
// come from GET /spaces/:id/pages, which is guest-capable and per-page FGA-gated on the share_link
// principal, so restricted / unpublished / (post-#244) private pages appear in neither the tree nor as
// titles. The component is fed a page list synthesised from the share token's single space — it never
// calls the member-only GET /spaces (Decision 0).
export interface TreeNode {
  id: string;
  title: string;
  children: TreeNode[];
  /** #903 / ADR-220 §14: an unnamed anchor for a page the guest may read under a parent they may not */
  placeholder?: boolean;
}

// #903 / ADR-220 §4 + §14 (owner ruling 2026-09-05): the anchors the server volunteers beside `pages`.
// Same wire shape the member tree consumes (`lazy-tree.ts`); it carries no field of the invisible page.
export interface GuestPlaceholder {
  token: string;
  under: string | null;
  parentToken: string | null;
  pages: Page[];
}

const byPosition = (a: Page, b: Page) => a.position - b.position;

interface TreeCtx { pages: Page[]; placeholders: GuestPlaceholder[]; anchored: Set<string> }

function pageNode(p: Page, ctx: TreeCtx): TreeNode {
  return { id: p.id, title: p.title, children: childrenOf(p.id, ctx) };
}

// One anchor row: the pages the server placed directly under it, then any deeper anchor in the same
// invisible chain — the member tree's own order (`lazy-tree.ts` placeholderNodes), so the two shells
// answer this situation identically.
function placeholderNode(ph: GuestPlaceholder, ctx: TreeCtx): TreeNode {
  return {
    id: `ph:${ph.token}`,
    title: "",
    placeholder: true,
    children: [
      ...[...ph.pages].sort(byPosition).map((p) => pageNode(p, ctx)),
      ...ctx.placeholders.filter((x) => x.parentToken === ph.token).map((x) => placeholderNode(x, ctx)),
    ],
  };
}

// A page's children: its ordinary visible-parented rows, then the anchors hanging under it. A page
// surfaced under an anchor keeps its real children here — they carry its id as `parentId`, so only the
// first hop out of invisible territory ever needs an anchor.
function childrenOf(parentId: string | null, ctx: TreeCtx): TreeNode[] {
  return [
    ...ctx.pages
      .filter((p) => (p.parentId ?? null) === parentId && !ctx.anchored.has(p.id))
      .sort(byPosition)
      .map((p) => pageNode(p, ctx)),
    ...ctx.placeholders
      .filter((ph) => ph.parentToken === null && ph.under === parentId)
      .map((ph) => placeholderNode(ph, ctx)),
  ];
}

// Build the guest tree from the FGA-filtered page set plus the anchors placed beside it.
//
// A page whose parent the guest cannot see arrives under an ANCHOR (§14) and keeps its depth: the
// hierarchy the reader is looking at is not flattened, and the anchor says only that a node they cannot
// view sits there — no id, title, position or child count of it. The older re-rooting rule (a page whose
// parent is absent becomes a root) stays as the floor for any row the server did not anchor: a permitted
// page is never orphaned out of the tree (#245).
export function buildTree(pages: Page[], placeholders: GuestPlaceholder[]): TreeNode[] {
  const anchored = new Set(placeholders.flatMap((ph) => ph.pages.map((p) => p.id)));
  const ctx: TreeCtx = { pages, placeholders, anchored };
  // Anchored pages are `present` too: their own children carry their id, and without this every one of
  // them would be re-rooted to the top level — the exact flattening the anchors exist to end.
  const present = new Set([...pages.map((p) => p.id), ...anchored]);
  return [
    ...pages
      .filter((p) => !anchored.has(p.id) && (p.parentId == null || !present.has(p.parentId)))
      .sort(byPosition)
      .map((p) => pageNode(p, ctx)),
    ...placeholders
      .filter((ph) => ph.parentToken === null && ph.under === null)
      .map((ph) => placeholderNode(ph, ctx)),
  ];
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
export function GuestSidebar({ pages, placeholders = [], loading = false, space, openId, onOpen, onCreate, homePageId, error, onRetry, onLoadMore }: { pages: Page[]; placeholders?: GuestPlaceholder[]; loading?: boolean; space?: { name: string; iconImageUrl: string | null }; openId: string | null; onOpen: (id: string) => void; onCreate?: () => Promise<void>; homePageId?: string | null; error: boolean; onRetry?: () => void; /** #1141 / ADR-220 §6.2 rev13: present while more of the closure is unexplored; calling it continues the SAME walk. */ onLoadMore?: () => void | Promise<void> }) {
  const { t } = useTranslation();
  const showSkeleton = useDelayedFlag(loading);
  const tree = buildTree(pages, placeholders);
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
      {/* #1141 / ADR-220 §6.2 rev13: the cap is still loud (this list is drawn unvirtualised and fully
          expanded, so a cut tree has to say so), but no longer a dead end — `onLoadMore` continues the
          SAME closure walk instead of leaving the reader with a fixed count and no way to see the rest.
          Superseded the #623 static "too large to show" notice.
          #1149 (ruling/#903): auto-loads via the SAME `MoreRow` the member tree uses, rather than a
          guest-only manual button — this shell has no per-branch virtualization signal to feed `enabled`,
          so it relies entirely on MoreRow's own scroll/keyboard/pointer eavesdropping on the ancestor
          `guest-sidebar` container (`hostTestId`, below). */}
      {onLoadMore && <MoreRow enabled={false} onVisible={onLoadMore} hostTestId="guest-sidebar" />}
    </nav>
  );
}

function GuestNode({ node, depth, openId, onOpen }: { node: TreeNode; depth: number; openId: string | null; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  if (node.placeholder) {
    // §4 ruling ②: ONE fixed, unnamed label for every cause — draft, private and restricted are
    // indistinguishable here on purpose, and it is the same label the member tree uses. Expandable
    // only: there is nothing to open, and expanding issues no request (§4.2 — its children are in hand).
    return (
      <div>
        <div className="flex items-center gap-1" style={{ paddingLeft: `${depth * 12 + 4}px` }} data-testid="guest-tree-placeholder">
          <button
            type="button"
            className="flex-none rounded p-0.5 text-fg-dim hover:text-foreground"
            onClick={() => setExpanded((e) => !e)}
            aria-label={expanded ? t("sidebar.collapse") : t("sidebar.expand")}
          >
            <ChevronRight size={12} className={expanded ? "rotate-90 transition-transform" : "transition-transform"} />
          </button>
          <span className="truncate py-1 pr-1 italic text-fg-dim">{t("sidebar.placeholderPage")}</span>
        </div>
        {expanded && node.children.map((c) => <GuestNode key={c.id} node={c} depth={depth + 1} openId={openId} onOpen={onOpen} />)}
      </div>
    );
  }
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
