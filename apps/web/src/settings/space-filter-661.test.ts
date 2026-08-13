import { describe, it, expect } from "vitest";
import { filterSpaceOptions, hiddenCount, type SpaceOption } from "./space-filter";

// #661 (user, on the device): " UI ".
//
// The list was every space the admin can see, as checkboxes, with no filter and no bound. This form was
// built in #637 slice 7, AFTER #623 had swept the other fourteen lists, so it inherited none of that
// work — and `GET /spaces` has no LIMIT either, which the #623 ledger misses because a subquery
// `LIMIT 1` (fetching one tenant setting) satisfies its bound-marker pattern.
//
// The assertions worth having are not "typing shortens the list". They are about what the form SUBMITS
// once it does.
const SPACES: SpaceOption[] = [
  { id: "eng", name: "Engineering" },
  { id: "mkt", name: "Marketing" },
  { id: "ops", name: "Operations" },
  { id: "hr", name: "人事" },
];

describe("#661: the filter narrows what is shown, never what is chosen", () => {
  it("a ticked space stays visible even when it stops matching", () => {
    // The failure this exists for: filter to "mark", and Engineering — already ticked — disappears while
    // remaining in the payload. The reader then issues a credential that reaches a space they cannot see
    // on the screen that is asking them to choose. A screenshot of that looks entirely correct.
    const shown = filterSpaceOptions(SPACES, "mark", [{ id: "eng", name: "Engineering" }]);
    expect(shown.map((s) => s.id), "the ticked space was filtered out of its own form").toContain("eng");
    expect(shown.map((s) => s.id)).toContain("mkt");
    expect(shown.map((s) => s.id), "…without dragging in everything else").not.toContain("ops");
  });

  it("nothing chosen means the filter is free to hide anything", () => {
    expect(filterSpaceOptions(SPACES, "mark", []).map((s) => s.id)).toEqual(["mkt"]);
  });

  it("matches case-insensitively, on the name a person actually reads", () => {
    // The id is a slug nobody picked. Matching it would make "eng" find Engineering by a string the
    // reader never sees, and then fail to find it by the string they do.
    expect(filterSpaceOptions(SPACES, "ENGIN", []).map((s) => s.id)).toEqual(["eng"]);
    expect(filterSpaceOptions(SPACES, "人事", []).map((s) => s.id)).toEqual(["hr"]);
    expect(filterSpaceOptions(SPACES, "eng", []).map((s) => s.id), "matched the slug, not the name")
      .toEqual(["eng"]); // "Engineering" contains "eng" — the NAME match, which is the one that counts
  });

  it("an empty or whitespace query is no filter, not a filter that matches nothing", () => {
    expect(filterSpaceOptions(SPACES, "", [])).toHaveLength(SPACES.length);
    expect(filterSpaceOptions(SPACES, "   ", []), "a stray space emptied the list").toHaveLength(SPACES.length);
  });

  it("a query that matches nothing yields nothing — and the count says how much is hidden", () => {
    const shown = filterSpaceOptions(SPACES, "zzz", []);
    expect(shown).toEqual([]);
    // "0 spaces" and "0 of 4" are different facts. Without the second, a narrowed list reads as a short
    // tenant, and a key gets issued against a roster the reader believes is complete.
    expect(hiddenCount(SPACES, shown)).toBe(4);
  });

  it("the hidden count never goes negative, and is zero when nothing is filtered", () => {
    expect(hiddenCount(SPACES, filterSpaceOptions(SPACES, "", []))).toBe(0);
    expect(hiddenCount(SPACES, [...SPACES, ...SPACES]), "a wider `shown` than `all` is not a negative")
      .toBe(0);
  });

  it("the list does not grow with the tenant — the filter is the reader's, the box is the product's", () => {
    // The box itself is `ListBox` (#639), which scrolls rather than stretches; that is measured on the
    // screen, not here. What IS here: filtering is O(n) over whatever arrived, and picks survive it, so
    // the two mechanisms compose rather than fighting.
    const many: SpaceOption[] = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, name: `Space ${i}` }));
    const picked = [{ id: "s399", name: "Space 399" }];
    const shown = filterSpaceOptions(many, "Space 1", picked);
    expect(shown.map((s) => s.id), "the pick survived a 400-space list").toContain("s399");
    expect(shown.length, "…and the filter still did its job").toBeLessThan(many.length);
  });
});

describe("#705: picked options survive a server-filtered page that lacks them", () => {
  it("a picked space missing from the list is PREPENDED with its own name", () => {
    const serverPage: SpaceOption[] = [{ id: "mkt", name: "Marketing" }];
    const shown = filterSpaceOptions(serverPage, "mark", [{ id: "eng", name: "Engineering" }]);
    expect(shown.map((s) => s.id)).toEqual(["eng", "mkt"]);
    expect(shown[0]!.name, "the missing pick kept its own name — the pick carries the OPTION (must-fix 6)").toBe("Engineering");
  });

  it("a picked space already present is not duplicated", () => {
    const shown = filterSpaceOptions(SPACES, "", [{ id: "eng", name: "Engineering" }]);
    expect(shown.filter((s) => s.id === "eng")).toHaveLength(1);
  });
});
