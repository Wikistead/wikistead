import { useMemo, useState, useCallback } from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../data/apiClient";
import type { Page } from "../data/queries";
import { useSession } from "../session/SessionProvider";
import type { PageTreeNode } from "./PageTree";

// #623 / ADR-220 §6.3: the sidebar tree, branch by branch.
//
// The whole-space read is gone from this surface: the first paint is §5's route (the root branch plus
// the path to the open page), and every other branch arrives when its row is expanded. The cache is
// per-branch — `["pages", spaceId, "branch", parentId]` — which keeps every existing invalidation
// working unchanged: `invalidateQueries({queryKey: ["pages", spaceId]})` prefix-matches the branch
// keys, so the ~15 sites that invalidate the space go on invalidating exactly what is loaded.
//
// Chevrons are ruling①, option (c): EVERY row is expandable, because any signal would either
// leak ("something you cannot see is here" — the (a) shape §3 forbids) or cost the first paint an FGA
// batch per row ((b), the surface #541 spent a slice making fast). Expanding a leaf shows nothing and
// the row folds back; the lie is "there may be children", never "something denied exists".

export interface BranchAnswer {
  pages: Page[];
  nextCursor: string | null;
  restarted?: boolean;
  placeholders?: { token: string; under: string | null; parentToken: string | null; pages: Page[] }[];
  placeholdersExhausted?: boolean;
}

interface PaintAnswer {
  branches: (BranchAnswer & { parentId: string | null })[];
}

const ROOT = "root";

export function branchKey(spaceId: string, parentId: string | null): (string | null)[] {
  return ["pages", spaceId, "branch", parentId ?? ROOT];
}

/**
 * The lazy tree: paint once, then one query per EXPANDED branch.
 *
 * The paint SEEDS the branch caches rather than being rendered directly — one source of truth per
 * branch, so a later expand/refetch of a painted branch does not race a second copy of it.
 */
export function useLazyPageTree(spaceId: string | null, openPageId: string | null) {
  const { token } = useSession();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const paint = useQuery({
    queryKey: ["pages", spaceId, "paint", openPageId ?? ""],
    enabled: !!spaceId,
    staleTime: 0,
    // #492: the tree is boot-critical — a transient failure used to stick as an empty sidebar until a
    // manual reload. The headroom moved here with the read itself (the whole-space query carried it).
    retry: 3,
    // The key carries the OPEN page, so every navigation is a new key — and without this the previous
    // answer vanishes for the fetch's duration and the whole tree unmounts on every page open
    // (measured: a freshly created page's row failed a 5s visibility wait because the tree was
    // rebuilding from nothing). The stale paint stays up; the new one replaces it when it lands.
    placeholderData: (prev: { paintedParents: (string | null)[] } | undefined) => prev,
    queryFn: async () => {
      const r = await apiFetch<PaintAnswer>(
        `/spaces/${spaceId}/pages/paint${openPageId ? `?open=${encodeURIComponent(openPageId)}` : ""}`, token);
      const branches: PaintAnswer["branches"] = r?.branches ?? [];
      for (const b of branches) {
        qc.setQueryData(branchKey(spaceId!, b.parentId), {
          pages: b.pages, nextCursor: b.nextCursor,
          placeholders: b.placeholders, placeholdersExhausted: b.placeholdersExhausted,
        } satisfies BranchAnswer);
      }
      return { paintedParents: branches.map((b) => b.parentId) };
    },
  });

  // Every branch that must be LIVE: the painted ones (kept fresh through their own keys) plus every
  // row the reader has expanded. A painted branch that was never expanded still refetches on
  // invalidation, because the query below owns its key once it has been seeded.
  const painted = paint.data?.paintedParents ?? [];
  const wanted = useMemo(() => {
    const set = new Set<string | null>(painted);
    for (const id of expanded) set.add(id);
    return [...set];
  }, [painted, expanded]);

  const branchQueries = useQueries({
    queries: wanted.map((parentId) => ({
      queryKey: branchKey(spaceId ?? "", parentId),
      enabled: !!spaceId,
      // NOT 0. The paint just seeded this key; a zero staleTime marks the seed instantly stale and
      // refetches every painted branch on mount — re-issuing, one request at a time, the answers §5
      // exists to deliver in one round trip (measured: the refetch of the root overwrote the seed).
      // Invalidations still bite: invalidateQueries marks stale regardless of this number.
      staleTime: 30_000,
      queryFn: async (): Promise<BranchAnswer> => {
        const qs = parentId ? `?parent=${encodeURIComponent(parentId)}` : "";
        const r = await apiFetch<BranchAnswer>(`/spaces/${spaceId}/pages/branch${qs}`, token);
        return r ?? { pages: [], nextCursor: null };
      },
    })),
  });

  const byParent = useMemo(() => {
    const m = new Map<string | null, BranchAnswer>();
    wanted.forEach((parentId, i) => {
      const d = branchQueries[i]?.data;
      if (d) m.set(parentId, d);
    });
    return m;
  }, [wanted, branchQueries]);

  const expand = useCallback((pageId: string) => {
    setExpanded((s) => (s.has(pageId) ? s : new Set([...s, pageId])));
  }, []);
  const collapse = useCallback((pageId: string) => {
    setExpanded((s) => { const n = new Set(s); n.delete(pageId); return n; });
  }, []);

  /** §1: a branch's next page arrives by scrolling — appended into the SAME cache entry. */
  const loadMore = useCallback(async (parentId: string | null) => {
    if (!spaceId) return;
    const key = branchKey(spaceId, parentId);
    const have = qc.getQueryData<BranchAnswer>(key);
    if (!have?.nextCursor) return;
    const qs = new URLSearchParams();
    if (parentId) qs.set("parent", parentId);
    qs.set("cursor", have.nextCursor);
    const r = await apiFetch<BranchAnswer>(`/spaces/${spaceId}/pages/branch?${qs}`, token);
    if (!r) return;
    // §8: a restarted read REPLACES what is held — appending would double what is already shown.
    qc.setQueryData<BranchAnswer>(key, r.restarted ? r : {
      ...r,
      pages: [...(have.pages ?? []), ...r.pages],
      placeholders: r.placeholders ?? have.placeholders,
    });
  }, [spaceId, token, qc]);

  return { paint, byParent, expanded, expand, collapse, loadMore };
}

/** The sentinel child that makes an UNLOADED row expandable (ruling ① (c): every row draws a chevron). */
export const UNLOADED_CHILD_PREFIX = "unloaded:";
/** A placeholder row (§4): unnamed, not openable, expandable only. */
export const PLACEHOLDER_PREFIX = "ph:";
/** The "more pages" row a branch grows when its cursor says so (§1). */
export const MORE_PREFIX = "more:";

/**
 * Assemble react-arborist nodes from the loaded branches.
 *
 * Every page row gets ONE child it cannot see past: its real children when the branch is loaded, or
 * the unloaded sentinel when it is not — which is what makes every row expandable without asking the
 * server anything (①(c)). Placeholders render as unnamed rows whose children are their visible pages;
 * they are DATA ALREADY IN HAND (§4.2), so expanding one issues no request — and they are built from
 * the same node shape as everything else, which is ruling ②'s .
 */
export function buildLazyNodes(args: {
  spaceId: string;
  byParent: ReadonlyMap<string | null, BranchAnswer>;
  pinnedPageIds: ReadonlySet<string>;
  placeholderName: string;
}): PageTreeNode[] {
  const { spaceId, byParent, pinnedPageIds, placeholderName } = args;

  const pageNode = (p: Page): PageTreeNode => ({
    id: `page:${p.id}`,
    name: p.title,
    pageId: p.id,
    spaceId,
    published: p.published ?? false,
    unpublished: p.hasUnpublishedChanges ?? false,
    private: p.private ?? false,
    frozen: p.frozen ?? null,
    taskDone: p.taskDone ?? 0,
    taskTotal: p.taskTotal ?? 0,
    pinned: pinnedPageIds.has(p.id),
    children: childrenOf(p.id),
  });

  const childrenOf = (parentId: string): PageTreeNode[] => {
    const branch = byParent.get(parentId);
    if (!branch) {
      // Not loaded: one sentinel child, so the chevron draws. It renders as a brief loading row for
      // the instant between the expand and the branch answer.
      return [{
        id: `${UNLOADED_CHILD_PREFIX}${parentId}`, name: "", pageId: "", spaceId,
        published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0, children: [],
      }];
    }
    return assemble(branch, parentId);
  };

  const placeholderNodes = (branch: BranchAnswer, under: string | null): PageTreeNode[] => {
    const all = branch.placeholders ?? [];
    const direct = all.filter((ph) => ph.parentToken === null && ph.under === under);
    const nest = (token: string): PageTreeNode[] => {
      const kids: PageTreeNode[] = [];
      for (const ph of all) {
        if (ph.parentToken === token) {
          kids.push({
            id: `${PLACEHOLDER_PREFIX}${ph.token}`, name: placeholderName, pageId: "", spaceId,
            published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0,
            children: [...ph.pages.map(pageNode), ...nest(ph.token)],
          });
        }
      }
      return kids;
    };
    return direct.map((ph) => ({
      id: `${PLACEHOLDER_PREFIX}${ph.token}`, name: placeholderName, pageId: "", spaceId,
      published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0,
      children: [...ph.pages.map(pageNode), ...nest(ph.token)],
    }));
  };

  const assemble = (branch: BranchAnswer, parentId: string | null): PageTreeNode[] => {
    const rows = [
      ...branch.pages.map(pageNode),
      ...placeholderNodes(branch, parentId),
    ];
    if (branch.nextCursor) {
      rows.push({
        id: `${MORE_PREFIX}${parentId ?? ROOT}`, name: "", pageId: "", spaceId,
        published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0, children: [],
      });
    }
    return rows;
  };

  const root = byParent.get(null);
  return root ? assemble(root, null) : [];
}
