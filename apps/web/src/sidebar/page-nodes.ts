import type { Page } from "../data/queries";
import type { PageTreeNode } from "./PageTree";

// One space at a time (Notion/Outline style): the sidebar shows ONLY the active
// space's page tree; the space itself is chosen in the switcher, not a tree root.
// Standalone module (type-only imports) so the badge-mapping test can pin it without pulling the
// component graph (#329 rework): the tree badges (private lock, frozen snowflake, ring) all ride on
// this mapping — a field dropped here is an invisible badge with every other test still green.
export function buildPageNodes(pages: Page[], parentId: string | null, pinnedPageIds: ReadonlySet<string>): PageTreeNode[] {
  return pages
    .filter((p) => p.parentId === parentId)
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ id: `page:${p.id}`, name: p.title, pageId: p.id, spaceId: p.spaceId, published: p.published ?? false, unpublished: p.hasUnpublishedChanges ?? false, private: p.private ?? false, frozen: p.frozen ?? null, taskDone: p.taskDone ?? 0, taskTotal: p.taskTotal ?? 0, pinned: pinnedPageIds.has(p.id), children: buildPageNodes(pages, p.id, pinnedPageIds) }));
}
