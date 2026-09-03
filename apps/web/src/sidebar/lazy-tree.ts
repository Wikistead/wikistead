import { useMemo, useState, useCallback, useEffect, useRef } from "react";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { mergePaintedWindow, mergeReachedWindow, visibleBranchPages } from "./scroll-to-selection"; // #899
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
// Chevrons are ruling ①, option (c): EVERY row is expandable, because any signal would either
// leak ("something you cannot see is here" — the (a) shape §3 forbids) or cost the first paint an FGA
// batch per row ((b), the surface #541 spent a slice making fast). Expanding a leaf shows nothing and
// the row folds back; the lie is "there may be children", never "something denied exists".

export interface BranchAnswer {
  pages: Page[];
  nextCursor: string | null;
  reachedWindow?: BranchAnswer;
  restarted?: boolean;
  placeholders?: { token: string; under: string | null; parentToken: string | null; pages: Page[] }[];
  placeholdersExhausted?: boolean;
}

interface PaintAnswer {
  branches: (BranchAnswer & { parentId: string | null })[];
}

/** ADR-238 §2: where the open row is — one level per ancestor, root-first. */
interface PathAnswer {
  levels: { parentId: string | null; cursor: string | null }[];
  exhausted: boolean;
}

const ROOT = "root";

/** #623 ③: how many rows the first paint confirms per branch. */
export const PAINT_LIMIT = 30;

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
      // #623 ③: confirm what the screen can SHOW (~20 rows visible; 30 leaves headroom), not
      // the whole branch. The rest arrives by scrolling through the `more:` row.
      const qs = new URLSearchParams({ limit: String(PAINT_LIMIT) });
      if (openPageId) qs.set("open", openPageId);
      const r = await apiFetch<PaintAnswer>(`/spaces/${spaceId}/pages/paint?${qs}`, token);
      const branches: PaintAnswer["branches"] = r?.branches ?? [];
      for (const b of branches) {
        const key = branchKey(spaceId!, b.parentId);
        // #1077 review C5: this route never sends `placeholders` (§4 moved it behind its own
        // follow-up, `placeholderQueries` below) — reading it here was the exact dead code that hid
        // the 3-week regression this ticket fixed. Not read; left unset so a future reader does not
        // reach for it here again.
        const fresh = { pages: b.pages, nextCursor: b.nextCursor } satisfies BranchAnswer;
        // #899: KEEP what the reader loaded past this window. The paint always returns a branch's
        // FIRST window (`paintTree`'s `one()` passes no cursor) and its key carries the open page, so
        // seeding unconditionally threw away every `more:` a scrolling reader had asked for — on every
        // navigation. The row they had just clicked went with it, which is the flicker.
        qc.setQueryData(key, mergePaintedWindow(qc.getQueryData<BranchAnswer>(key), fresh));
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
        const fresh = r ?? { pages: [], nextCursor: null };
        return mergePaintedWindow(
          qc.getQueryData<BranchAnswer>(branchKey(spaceId!, parentId)),
          fresh,
        );
      },
    })),
  });

  // #623 / ADR-220 §4.5, ②: placeholders ride a branch's FIRST page, but no longer arrive INSIDE
  // it — `listBranch`/`paintTree` stopped resolving them (the 728-tuple-per-open cost §4.3 measured),
  // and the commit message describes a follow-up fetch that was never actually wired on this side.
  // From that commit until this one, EVERY invisible-parent-with-a-visible-child page was unreachable
  // from the member sidebar — the exact "accident, not decision" silent-drop §4.6 names as the bug
  // ADR-220 existed to fix, reintroduced by an unrelated performance change. One request per branch
  // (matching the branch query's own cardinality, never per `loadMore` page — §4.5), kept in its own
  // cache entry rather than folded into the branch's, so an unrelated paint/branch refetch (staleTime 0
  // on `paint`, so this happens on every navigation) can never clobber it the way `mergePaintedWindow`
  // would if it lived inside the same `BranchAnswer` the server actually returns.
  const placeholderQueries = useQueries({
    queries: wanted.map((parentId) => ({
      queryKey: ["pages", spaceId ?? "", "placeholders", parentId ?? ROOT],
      enabled: !!spaceId,
      staleTime: 30_000,
      queryFn: async () => {
        const qs = parentId ? `?parent=${encodeURIComponent(parentId)}` : "";
        return apiFetch<{ placeholders: NonNullable<BranchAnswer["placeholders"]>; placeholdersExhausted: boolean }>(
          `/spaces/${spaceId}/pages/tree-placeholders${qs}`, token,
        );
      },
    })),
  });

  const byParent = useMemo(() => {
    const m = new Map<string | null, BranchAnswer>();
    wanted.forEach((parentId, i) => {
      const d = branchQueries[i]?.data;
      if (!d) return;
      const ph = placeholderQueries[i]?.data;
      m.set(parentId, ph ? { ...d, placeholders: ph.placeholders, placeholdersExhausted: ph.placeholdersExhausted } : d);
    });
    return m;
  }, [wanted, branchQueries, placeholderQueries]);

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
    // #1077 review C5: no `placeholders` field to carry forward here either (see the paint queryFn's
    // comment) — `byParent` supplies it at read time from `placeholderQueries`, not from this cache.
    qc.setQueryData<BranchAnswer>(key, r.restarted ? r : {
      ...r,
      pages: [...(have.pages ?? []), ...r.pages],
      reachedWindow: have.reachedWindow,
    });
  }, [spaceId, token, qc]);

  // ADR-238 / #739: REACH the open row when the paint did not already hold it.
  //
  // The paint fetches the branch of every ancestor, but each comes back as its FIRST window — so a page
  // past row 30 of its branch is simply not in the tree, and the reader who was sent a link lands on a
  // sidebar that does not show where they are. Measured on a 60-page space: the row never appeared.
  //
  // What this is NOT is a loop over `more:` until the row turns up. That is unbounded in exactly the
  // shape #705 / #710 ruled against, and the cost falls on the reader who did the least to deserve it.
  // The server knows the ordering, so it answers WHICH WINDOW in one round trip, and this fetches only
  // the levels whose window the paint got wrong — usually one, never more than the depth of the page.
  //
  // ⚠️ It runs only when the row is ABSENT. Nothing happens for a page in the first window of its
  // branch, which is nearly every page: the common navigation costs no extra request at all.
  const reachedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!spaceId || !openPageId) return;
    if (reachedFor.current === openPageId) return;
    // Wait for the paint. Acting before it lands would ask for a path the paint is about to deliver.
    if (!paint.data) return;
    const held = [...byParent.values()].some((branch) =>
      visibleBranchPages(branch).some((page) => page.id === openPageId));
    reachedFor.current = openPageId;
    if (held) return;
    const wantedFor = openPageId;
    void (async () => {
      const r = await apiFetch<PathAnswer>(
        `/spaces/${spaceId}/pages/${encodeURIComponent(wantedFor)}/path?limit=${PAINT_LIMIT}`, token,
      );
      // A page the reader cannot view answers 404 and `apiFetch` yields nothing. There is no fallback
      // to try: the row is not theirs to see, and the sidebar simply stays as the paint drew it.
      if (!r) return;
      for (const level of r.levels) {
        // No cursor means the target is in the branch's first window, which the paint already fetched.
        if (!level.cursor) continue;
        const qs = new URLSearchParams();
        if (level.parentId) qs.set("parent", level.parentId);
        qs.set("cursor", level.cursor);
        qs.set("limit", String(PAINT_LIMIT));
        const b = await apiFetch<BranchAnswer>(`/spaces/${spaceId}/pages/branch?${qs}`, token);
        // This window is somewhere else in the branch entirely. Keep it as a separate reached window:
        // replacing loses the first window on reload, while concatenating lies that the runs are adjacent.
        if (b) {
          const key = branchKey(spaceId, level.parentId);
          qc.setQueryData(key, mergeReachedWindow(qc.getQueryData<BranchAnswer>(key), b));
        }
      }
      // Ruling ③: expand the chain even where the reader had collapsed it — they asked for this page by
      // opening it. Done after the fetches so each key already holds its window when the query mounts.
      const chain = r.levels.map((l) => l.parentId).filter((id): id is string => !!id);
      if (chain.length) setExpanded((prev) => new Set([...prev, ...chain]));
    })();
  }, [spaceId, openPageId, paint.data, byParent, token, qc]);

  return { paint, byParent, expanded, expand, collapse, loadMore };
}

/** The sentinel child that makes an UNLOADED row expandable (ruling ① (c): every row draws a chevron). */
export const UNLOADED_CHILD_PREFIX = "unloaded:";
/** A placeholder row (§4): unnamed, not openable, expandable only. */
export const PLACEHOLDER_PREFIX = "ph:";
/** The "more pages" row a branch grows when its cursor says so (§1). */
export const MORE_PREFIX = "more:";
/** #1079 / ADR-220 §4.3: the branch's placeholder budget ran out before every invisible chain was walked. */
export const PLACEHOLDERS_EXHAUSTED_PREFIX = "ph-exhausted:";

/**
 * Assemble react-arborist nodes from the loaded branches.
 *
 * Every page row gets ONE child it cannot see past: its real children when the branch is loaded, or
 * the unloaded sentinel when it is not — which is what makes every row expandable without asking the
 * server anything (①(c)). Placeholders render as unnamed rows whose children are their visible pages;
 * they are DATA ALREADY IN HAND (§4.2), so expanding one issues no request — and they are built from
 * the same node shape as everything else, which is ruling ②'s "exactly the same shape".
 */
export function buildLazyNodes(args: {
  spaceId: string;
  byParent: ReadonlyMap<string | null, BranchAnswer>;
  pinnedPageIds: ReadonlySet<string>;
  placeholderName: string;
  placeholdersExhaustedLabel: string;
}): PageTreeNode[] {
  const { spaceId, byParent, pinnedPageIds, placeholderName, placeholdersExhaustedLabel } = args;

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
    children: childrenOf(p),
  });

  // #623 ①: the sentinel — and with it the chevron — exists ONLY for a row the server says has
  // a child the reader can see (`hasChildren`, folded into the branch's own batchCheck). The previous
  // ruling drew one on every row and the rejection called it what it was: a chevron on a childless
  // page is a lie the reader pays for with a click. An invisible-only child reads as ABSENT here —
  // nothing says "something you cannot see is here".
  const childrenOf = (p: Page): PageTreeNode[] => {
    const branch = byParent.get(p.id);
    if (!branch) {
      if (!p.hasChildren) return [];
      // has a visible child, not yet loaded: one sentinel child, so the chevron draws. It renders as
      // a brief loading row for the instant between the expand and the branch answer.
      return [{
        id: `${UNLOADED_CHILD_PREFIX}${p.id}`, name: "", pageId: "", spaceId,
        published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0, children: [],
      }];
    }
    return assemble(branch, p.id);
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
    if (branch.placeholdersExhausted) {
      // #1079 / ADR-220 §4.3: "exhausting it is a visible state ... never a short answer that looks
      // complete". The budget is spent per branch resolution (`tree-placeholders.ts`), so this row is
      // per branch too — the same row shape as MORE_PREFIX, but there is nothing more to ask for; it
      // only says the placement search gave up early and points the reader at search instead.
      rows.push({
        id: `${PLACEHOLDERS_EXHAUSTED_PREFIX}${parentId ?? ROOT}`, name: placeholdersExhaustedLabel, pageId: "", spaceId,
        published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0, children: [],
      });
    }
    if (branch.nextCursor) {
      // #623 (the "more" row misfiring): the row's id CARRIES THE CURSOR. With a fixed id the
      // arborist row survives the append, its mount-once guard stays spent, and the next page never
      // loads — one fetch per branch, however deep it went. A new cursor is a new id is a fresh row.
      rows.push({
        id: `${MORE_PREFIX}${parentId ?? ROOT}:${branch.nextCursor}`, name: "", pageId: "", spaceId,
        published: true, unpublished: false, private: false, taskDone: 0, taskTotal: 0, children: [],
      });
    }
    const primary = new Set(branch.pages.map((page) => page.id));
    rows.push(...visibleBranchPages(branch)
      .filter((page) => !primary.has(page.id))
      .map(pageNode));
    return rows;
  };

  const root = byParent.get(null);
  return root ? assemble(root, null) : [];
}
