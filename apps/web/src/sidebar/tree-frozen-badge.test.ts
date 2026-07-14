// @vitest-environment happy-dom
// #329 rework: the sidebar tree must carry the freeze level so the row can pair a Snowflake with the
// private Lock (the title bar shows both; the tree showing only the lock was the review rejection).
// The badges all ride on Sidebar's buildPageNodes mapping — a field dropped there renders NO badge with
// every test still green, so this pins the mapping itself (PageTree renders `d.frozen &&` off these nodes).
import { describe, it, expect } from "vitest";
import { buildPageNodes } from "./page-nodes";
import type { Page } from "../data/queries";

const page = (id: string, extra: Partial<Page> = {}): Page =>
  ({ id, spaceId: "s1", parentId: null, title: id, position: 0, ...extra }) as Page;

describe("buildPageNodes badge mapping (#329 rework)", () => {
  it("maps the freeze level onto the tree node, alongside private", () => {
    const nodes = buildPageNodes(
      [page("full", { frozen: "full" }), page("guests", { frozen: "guests", private: true }), page("plain")],
      null,
      new Set(),
    );
    const byId = Object.fromEntries(nodes.map((n) => [n.pageId, n]));
    expect(byId["full"]!.frozen).toBe("full");
    expect(byId["guests"]!.frozen).toBe("guests");
    expect(byId["guests"]!.private).toBe(true); // the lock and the snowflake coexist on one row
    expect(byId["plain"]!.frozen).toBe(null); // absent from the API payload → no badge
  });

  it("keeps the level on nested children (the recursive branch of the mapping)", () => {
    const nodes = buildPageNodes(
      [page("parent"), page("child", { parentId: "parent", frozen: "full" })],
      null,
      new Set(),
    );
    expect(nodes[0]!.children?.[0]?.frozen).toBe("full");
  });
});
