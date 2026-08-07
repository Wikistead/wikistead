import { describe, it, expect } from "vitest";
import { walkRevisions, walkPages, type RevisionsPage, type ShareLinksPage } from "./queries";
import type { Revision } from "./queries";

// #623: the history endpoint is paged now, so the panel gets its list by walking. This pins the walk.
//
// The panel needs the WHOLE list, not a first page: `latestRun` reads the newest contiguous run of one
// actor off it, and a short list would offer to revert more edits than the count beside it names.
// ruled that affordance may only appear when it is honest, so a walk that quietly stops is not a
// cosmetic bug — it makes a moderation control lie.
//
// A stopped walk has no symptom on screen: the history simply looks shorter. So it is measured here
// rather than left to a UI assertion that would pass on any prefix.

const rev = (id: string): Revision => ({
  id, pageId: "p", title: id, createdBy: "user:x", createdAt: "2026-01-01T00:00:00.000Z",
} as Revision);

/** A server that hands out `pages` in order and records what it was asked for. */
function paged(pages: RevisionsPage[]) {
  const asked: (string | null)[] = [];
  let i = 0;
  return {
    asked,
    fetchPage: async (cursor: string | null) => {
      asked.push(cursor);
      return pages[i++] ?? null;
    },
  };
}

describe("#623: the history walk", () => {
  it("returns every page's rows, in order", async () => {
    const { fetchPage } = paged([
      { revisions: [rev("a"), rev("b")], nextCursor: "c1" },
      { revisions: [rev("c")], nextCursor: "c2" },
      { revisions: [rev("d")], nextCursor: null },
    ]);
    expect((await walkRevisions(fetchPage)).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("carries each page's cursor into the next request", async () => {
    // …because a walk that never advances returns page one for ever, and the list still looks fine.
    const { asked, fetchPage } = paged([
      { revisions: [rev("a")], nextCursor: "c1" },
      { revisions: [rev("b")], nextCursor: null },
    ]);
    await walkRevisions(fetchPage);
    expect(asked).toEqual([null, "c1"]);
  });

  it("keeps going past an EMPTY page that still has a cursor", async () => {
    // The failure the server's own comment warns about: authorization filtering runs after the query,
    // so a page can carry no visible row while every row after it is visible. Stopping on emptiness
    // loses the whole tail — and looks exactly like "there is no more history".
    const { fetchPage } = paged([
      { revisions: [rev("a")], nextCursor: "c1" },
      { revisions: [], nextCursor: "c2" },
      { revisions: [rev("b")], nextCursor: null },
    ]);
    expect((await walkRevisions(fetchPage)).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("stops when the cursor is null, not when the rows run out", async () => {
    const { asked, fetchPage } = paged([{ revisions: [rev("a")], nextCursor: null }]);
    await walkRevisions(fetchPage);
    expect(asked).toEqual([null]);
  });

  it("a request that answers with nothing ends the walk instead of looping", async () => {
    const { fetchPage } = paged([{ revisions: [rev("a")], nextCursor: "c1" }]);
    expect((await walkRevisions(fetchPage)).map((r) => r.id)).toEqual(["a"]);
  });

  it("the SAME loop serves the share-link dialog — there is one walk, not two", async () => {
    // #623: `useShareLinks` walks too, and the dialog is the only place a link can be revoked, so a
    // short list is a link nobody knows to take away. Written through `walkPages` rather than copied,
    // because a second copy is where "stop on an empty page" comes back.
    const pages: ShareLinksPage[] = [
      { links: [{ id: "l1" }, { id: "l2" }] as ShareLinksPage["links"], nextCursor: "c1" },
      { links: [] as ShareLinksPage["links"], nextCursor: "c2" },
      { links: [{ id: "l3" }] as ShareLinksPage["links"], nextCursor: null },
    ];
    let i = 0;
    const got = await walkPages(async () => pages[i++] ?? null, (p: ShareLinksPage) => p.links);
    expect(got.map((l) => l.id)).toEqual(["l1", "l2", "l3"]);
  });
});
