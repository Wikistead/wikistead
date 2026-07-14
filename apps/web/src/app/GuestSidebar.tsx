import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, FileText, Plus } from "lucide-react";
import type { Page } from "../data/queries";
import { SpaceIcon } from "../ui/SpaceIcon";
import { Input } from "../ui/Input";

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

// onCreate (#274 / ADR-135): present ONLY for an EDIT-capability space link — the one write affordance in
// the guest chrome. The title is asked inline (guests cannot rename afterwards: PATCH /pages/:id is
// member-only, so the title is fixed at the atomic create-publish). The server stays the fortress: the
// route re-checks FGA `edit` on the space and applies the created-page cap regardless of this UI.
export function GuestSidebar({ pages, space, openId, onOpen, onCreate }: { pages: Page[]; space?: { name: string; iconImageUrl: string | null }; openId: string | null; onOpen: (id: string) => void; onCreate?: (title: string) => Promise<void> }) {
  const { t } = useTranslation();
  const tree = buildTree(pages);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!onCreate || busy) return;
    setBusy(true);
    try {
      await onCreate(title.trim());
      setCreating(false);
      setTitle("");
    } finally {
      setBusy(false);
    }
  };
  // #270: the header shows the real space name + icon (member-parity), falling back to the generic label
  // only when the space info hasn't loaded. The icon uses the public /spaces/:id/icon-image (guest-readable),
  // and SpaceIcon falls back to an initials chip if there is no uploaded image.
  const heading = space?.name || t("share.spaceTitle");
  return (
    <nav className="flex h-full flex-col gap-0.5 overflow-auto p-2 text-[length:var(--text-ui)]" data-testid="guest-sidebar" aria-label={heading}>
      <div className="flex items-center gap-1.5 px-1 pb-1.5 font-semibold text-foreground" data-testid="guest-space-heading">
        {space ? <SpaceIcon id={space.name} name={space.name} image={space.iconImageUrl} size={18} /> : null}
        <span className="truncate">{heading}</span>
      </div>
      {onCreate && (
        creating ? (
          <Input
            autoFocus
            inputSize="sm"
            value={title}
            aria-label={t("share.newPageTitle")}
            placeholder={t("share.newPageTitle")}
            data-testid="guest-new-page-title"
            disabled={busy}
            className="mb-1"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") { setCreating(false); setTitle(""); }
            }}
            onBlur={() => { if (!busy) { setCreating(false); setTitle(""); } }}
          />
        ) : (
          <button
            type="button"
            data-testid="guest-new-page"
            className="mb-1 flex items-center gap-1.5 rounded px-1 py-1 text-left text-fg-dim hover:bg-panel-2 hover:text-foreground"
            onClick={() => setCreating(true)}
          >
            <Plus size={13} className="flex-none" />
            <span>{t("share.newPage")}</span>
          </button>
        )
      )}
      {tree.length === 0 ? (
        <div className="px-1 py-2 text-fg-dim" data-testid="guest-sidebar-empty">{t("share.spaceEmpty")}</div>
      ) : (
        tree.map((n) => <GuestNode key={n.id} node={n} depth={0} openId={openId} onOpen={onOpen} />)
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
      <div
        className={`flex items-center gap-1 rounded ${openId === node.id ? "bg-panel-2" : "hover:bg-panel-2"}`}
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
