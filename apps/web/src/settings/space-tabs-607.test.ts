// #607 (review rejection, 2026-08-04): a verb the server reports must open a door.
//
// `space#access_manager` shipped complete on the server — the roster routes answered 204, the ceiling
// answered 403, every route test was green — and the UI gate that decides who may enter space settings
// listed its exceptions by hand. `canManageAccess` was not on that list, so the principal the verb
// exists for could not reach the screen the verb operates. Nothing on the server side could see it.
//
// This pin walks the PAYLOAD'S OWN signal fields: for every capability signal the space listing carries,
// a caller holding just that signal must reach at least one tab. It names no verb, so the fourth one
// fails here on arrival rather than shipping locked out.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reachableSpaceTabs, landingSpaceTab, SPACE_TAB_KEYS } from "./space-tabs";

/** The `can…` booleans the server sends on a space, read off the client's own type declaration. */
function signalFields(): string[] {
  const src = readFileSync(resolve(import.meta.dirname, "../data/queries.ts"), "utf8");
  const start = src.indexOf("export interface Space {");
  expect(start, "the space payload's type is declared").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  return [...body.matchAll(/^\s*(can[A-Z]\w*)\??:\s*boolean/gm)].map((m) => m[1]!);
}

describe("#607: every capability the server reports opens at least one tab", () => {
  it("the signals were found (a walk over nothing proves nothing)", () => {
    const fields = signalFields();
    expect(fields.length, `no can* signals found on the space payload`).toBeGreaterThanOrEqual(2);
  });

  it("each signal, held alone, reaches a tab", () => {
    const locked: string[] = [];
    for (const field of signalFields()) {
      const tabs = reachableSpaceTabs({ capability: "view", [field]: true });
      if (tabs.length === 0) locked.push(field);
    }
    expect(locked, "a verb the server grants with no way into the screen it operates").toEqual([]);
  });

  it("and the landing tab is one the caller can actually see", () => {
    for (const field of signalFields()) {
      const space = { capability: "view" as const, [field]: true };
      const landing = landingSpaceTab(space);
      expect(landing, `${field} lands nowhere`).not.toBeNull();
      expect(reachableSpaceTabs(space), `${field} lands on a tab it cannot open`).toContain(landing);
    }
  });
});

describe("#607: the resolver keeps the shape the earlier rulings gave it", () => {
  it("a manager gets every tab, in the strip's order", () => {
    expect(reachableSpaceTabs({ capability: "manage" })).toEqual([...SPACE_TAB_KEYS]);
  });

  it("a plain viewer gets none — settings stay denied (the leak rule is unchanged)", () => {
    expect(reachableSpaceTabs({ capability: "view" })).toEqual([]);
    expect(reachableSpaceTabs({ capability: "edit" })).toEqual([]);
    expect(reachableSpaceTabs(undefined)).toEqual([]);
  });

  it("#326: a moderator reaches the queue and nothing else", () => {
    expect(reachableSpaceTabs({ capability: "view", canModerate: true })).toEqual(["moderation"]);
  });

  it("#607: an access-manager reaches the roster and nothing else", () => {
    expect(reachableSpaceTabs({ capability: "view", canManageAccess: true })).toEqual(["members"]);
  });

  it("two verbs open two tabs, in one order (the strip does not rearrange itself per caller)", () => {
    expect(reachableSpaceTabs({ capability: "view", canModerate: true, canManageAccess: true }))
      .toEqual(["members", "moderation"]);
  });
});

describe("#607: the screens ask the resolver rather than repeating the verb list", () => {
  it("the settings layout and the sidebar both go through it", () => {
    const layout = readFileSync(resolve(import.meta.dirname, "./SpaceSettingsPage.tsx"), "utf8");
    expect(layout, "the layout gates on the resolver").toMatch(/reachableSpaceTabs\(/);
    expect(layout, "and no longer carves out a per-verb exception").not.toMatch(/space\.capability !== "manage" && !canModerate/);
    const sidebar = readFileSync(resolve(import.meta.dirname, "../sidebar/Sidebar.tsx"), "utf8");
    expect(sidebar, "the sidebar's settings entry asks the same question").toMatch(/landingSpaceTab\(/);
    expect(sidebar, "…and does not list the verbs itself").not.toMatch(/\(canManage \|\| canModerate\) &&/);
  });
});
