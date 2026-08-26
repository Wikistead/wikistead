// #888: a list that could not be fetched is not an empty list.
//
// THE DEFECT: react-query's `isLoading` goes false the moment a request settles, success or not, and
// `data` stays undefined on failure. `!isLoading && (data?.length ?? 0) === 0` therefore renders the
// empty state for a fetch that FAILED. #500 found this on the page tree — a space with pages looked
// like a space with none — and the ruling was "error ≠ empty". Six surfaces still had the shape.
//
// ⚠️ TWO OF THEM ANSWER A QUESTION ABOUT ACCESS. A share-link list and a page's permissions list that
// say "nobody" because a request failed tell an admin doing a review that the page is closed, when
// nothing of the sort was established. That is the reason this is a bug and not a polish item.
//
// This walks the tree rather than listing the six: the next surface written in this shape has to be
// caught by a test nobody remembers to update. A walk that matches nothing is a red.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_ROOT = resolve(import.meta.dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) { if (entry !== "node_modules") walk(p, out); }
    else if ((p.endsWith(".tsx") || p.endsWith(".ts")) && !p.includes(".test.")) out.push(p);
  }
  return out;
}

// `(x.data?.length ?? 0) === 0`, `!x.data?.length`, `x.data?.length === 0` — the ways this tree spells
// #895: THE FIRST VERSION OF THIS WALK ONLY KNEW ONE SPELLING. It matched `x.data?.length`, so a
// surface that destructured (`const { data: revisions } = useX()`) passed straight through, and so did
// one whose rows arrive already flattened. Twenty surfaces were outside a pin that called itself a
// discovery walk — including the compliance ledger, which answered "no entries" to a 500.
//
// Two more shapes made the old rule wrong in the other direction as well:
//   ① a surface that reads `error` for ONE code (an entitlement 403) and lets every other failure fall
//      through to the empty state — it "reads error", so a rule that looks for the word passes it;
//   ② a surface fed by props, where the failure belongs to the caller and cannot be seen from here.
//
// So the question is no longer "does this file ask a query whether it failed". It is: DOES THIS FILE
// DRAW SOMETHING WHEN THE FETCH FAILS. That is one shared component (`LoadFailed`) or an early return,
// and neither can be satisfied by mentioning a word.
//
// #895 round 5: the old alternation (`\.empty` / `empty[A-Z]\w*` / `noResults`) required the literal
// LOWERCASE run "empty" — so a key spelled camelCase with the capital mid-word, `adminRoles.customEmpty`
// or `related.graphEmpty`, contained no lowercase "empty" substring at all and the walk never found the
// site — not "handled via borrowing", MISSING FROM THE WALK ENTIRELY, measured (0 matches) before this
// line changed. `[Ee]mpty` accepts both spellings; `\w*` still allows a trailing word (`emptyTitle`).
const EMPTY_STATE = /t\("([\w.]*(?:[Ee]mpty\w*|noResults))"\)/g;

// Drawn on failure: the shared view, the surface removing itself, or a TERNARY that branches on the
// same isError/error the component itself is holding (round 5: GuestSidebar's `error ? <ownUI/> : …`
// — a real #500 fix, in a shape neither of the first two patterns was written to see; broadening
// EMPTY_STATE surfaced it as a false red). A mention of `error` inside a mutation's `onError` is not
// this — TERNARY_ON_FAILURE requires the `?` immediately after the identifier, which `onError: () =>`
// never has.
const DRAWS_ON_FAILURE = /<LoadFailed\b/;
const RETURNS_ON_FAILURE = /if\s*\([^)]*\b(?:isError|error)\b[^)]*\)\s*return\b/;
// `(?!:)` excludes an optional PARAMETER/PROP declaration (`error?: boolean`) — measured: without it,
// GuestSidebar's own destructured `{ error?: boolean }` signature satisfied this even with its actual
// `error ? <ownUI/> : …` ternary DELETED, so the break-check that should have gone red stayed green.
const TERNARY_ON_FAILURE = /\b(?:isError|error)\s*\?(?!:)/;

// ⚠️ Judged per COMPONENT, not per file — and not by a character window either. Both were measured
// here: with a file-wide rule, taking the failure view out of the audit ledger stayed green because
// the transparency section further down has its own `if (q.error) return null`; with a 2500-character
// window, the same borrowing happened from just far enough away. One component's handling excusing
// another's is the hole #886 already found in a pin that read positions out of a whole file.
const componentAround = (src: string, at: number): string => {
  const before = src.slice(0, at);
  const start = Math.max(before.lastIndexOf("\nfunction "), before.lastIndexOf("\nexport function "));
  const rest = src.slice(at);
  const endRel = Math.min(
    ...[rest.indexOf("\nfunction "), rest.indexOf("\nexport function ")].filter((i) => i > -1).concat([rest.length]),
  );
  return src.slice(start > -1 ? start : 0, at + endRel);
};

// Prop-fed surfaces: the data (and therefore the failure) belongs to the caller, not this component.
// #895 (round 1): naming the caller in PROSE is not checking it — AdminApiTab rendered
// ApiKeysPanel with `keys.data ?? []` and never read `keys.isError`, while this file's exclusion entry
// kept asserting the delegation was safe because ApiKeysPanel.tsx still existed.
// #895 c68xx (round 2, this reopening): prose was fixed for ApiKeysPanel by walking its render sites
// (below), but `app/HomeEmpty.tsx` kept a SECOND prose-only entry in a table nothing cross-checked
// against the first — `HomeLanding` rendered it without reading `spaces.isError` and nothing caught
// it, because "keeps both exclusion lists live" only proves an entry's file still exists, never that
// its callers are actually walked. So there is now exactly ONE table: a delegated file with no render
// pattern is a hole by construction, not by omission.
const DELEGATED: Record<string, { reason: string; renderPattern: RegExp }> = {
  "settings/ApiKeysPanel.tsx": {
    reason: "keys arrive as a prop — AccountPage and AdminApiTab own the fetch",
    renderPattern: /<ApiKeysPanel\b/,
  },
  "app/HomeEmpty.tsx": {
    reason: "presentational: the caller decides there are no spaces and renders this",
    renderPattern: /<HomeEmpty\b/,
  },
};

// One evaluation, used everywhere "is this failure handled" is asked — a second copy is exactly how
// TERNARY_ON_FAILURE nearly went missing from one of the two call sites below.
const isHandled = (around: string): boolean =>
  DRAWS_ON_FAILURE.test(around) || RETURNS_ON_FAILURE.test(around) || TERNARY_ON_FAILURE.test(around);

// Empty states that are NOT about a fetch. Named one by one, because a category would swallow the
// next real one: an empty frontmatter block and an empty page body are facts about the document in
// hand, not answers a request came back with.
const NOT_A_FETCH: Record<string, string> = {
  "editor/live-preview/frontmatter.ts": "an empty frontmatter block in the open document",
  "app/routes.tsx": "page.empty / page.emptyEditable describe a page with no body — #886 owns the fetch states here",
  // #895 round 5: `list.fetch` (Editor.tsx, the `:::tagged`/`:::children` host source) is typed and
  // documented (decorations.ts, `ListSource.fetch`) to return null for denied AND network failure
  // INDISTINGUISHABLY — existence-hiding for a member-only, view-filtered list, not an oversight.
  // Telling the two apart (to draw a LoadFailed on network failure only) would need a new signal this
  // route deliberately does not send, which makes it a stop:authz design change, not a bug fix.
  "editor/Editor.tsx": "macro.listEmpty (:::tagged/:::children) — ListSource.fetch is existence-hiding by design (denied and network-failure both resolve null); see decorations.ts's ListSource doc comment",
};

type Site = { file: string; keys: string[]; handled: boolean; delegated: boolean };

const sites: Site[] = [];
for (const file of walk(SRC_ROOT)) {
  const src = readFileSync(file, "utf8");
  const keys = [...src.matchAll(EMPTY_STATE)].map((m) => m[1]!);
  if (keys.length === 0) continue;
  const rel = file.slice(SRC_ROOT.length + 1);
  if (rel in NOT_A_FETCH) continue;
  for (const m of src.matchAll(EMPTY_STATE)) {
    const around = componentAround(src, m.index!);
    sites.push({
      file: rel,
      keys: [m[1]!],
      handled: isHandled(around),
      delegated: rel in DELEGATED,
    });
  }
}

// Every JSX render of a delegated component, wherever it lives — not just the files this ticket
// happened to fix. A caller found here that does NOT guard the render is exactly the AdminApiTab gap
// (round 1) and the HomeLanding gap (round 2).
type CallSite = { caller: string; delegatee: string; handled: boolean };
const callSites: CallSite[] = [];
for (const [delegatee, { renderPattern }] of Object.entries(DELEGATED)) {
  for (const file of walk(SRC_ROOT)) {
    const rel = file.slice(SRC_ROOT.length + 1);
    if (rel === delegatee) continue; // the delegated component itself, not a caller
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(new RegExp(renderPattern.source, "g"))) {
      const around = componentAround(src, m.index!);
      callSites.push({ caller: rel, delegatee, handled: isHandled(around) });
    }
  }
}

describe("#888 a failed fetch is not an empty list", () => {
  it("finds the empty-state surfaces at all", () => {
    // The guard on the walk. #895 is what happens when this number is met by a walk that is still
    // missing most of the tree, so it is set from what the tree actually holds rather than from the
    // handful this ticket started with.
    expect(sites.length, `no empty-state surfaces found under ${SRC_ROOT}`).toBeGreaterThanOrEqual(20);
  });

  it("keeps both exclusion lists live", () => {
    // An allowlist that outlives the thing it excuses is a hole: the file is renamed, the entry stays,
    // and the next surface to take that path is excused by a line about something else.
    for (const rel of Object.keys(DELEGATED)) {
      expect(sites.some((s) => s.file === rel), `${rel} no longer renders an empty state — drop the entry`).toBe(true);
    }
    for (const rel of Object.keys(NOT_A_FETCH)) {
      expect(existsSync(resolve(SRC_ROOT, rel)), `${rel} is gone — drop the entry`).toBe(true);
    }
  });

  it.each(sites.map((s) => [`${s.file} (${s.keys.join(", ")})`, s] as const))(
    "%s draws something when the fetch fails",
    (_label, site) => {
      if (site.delegated) return; // the caller owns it — asserted above that the entry is still live
      expect(
        site.handled,
        `${site.file} renders ${site.keys.join(", ")} but nothing when the fetch fails, so a failure ` +
          "reads as a finding. Either draw <LoadFailed> or return early on the error.",
      ).toBe(true);
    },
  );

  it("finds at least one render site for every delegated component (the walk is not vacuous)", () => {
    // Per-entry, not just a total count: a total floor stays green when one entry's render pattern
    // breaks as long as another entry's call sites make up the number — exactly the shape that let
    // HomeEmpty's entry sit unchecked while ApiKeysPanel's was walked.
    for (const delegatee of Object.keys(DELEGATED)) {
      expect(
        callSites.some((c) => c.delegatee === delegatee),
        `${delegatee} is in DELEGATED but no caller renders it — the render pattern broke, or it has no callers left (drop the entry)`,
      ).toBe(true);
    }
  });

  it.each(callSites.map((c) => [`${c.caller} renders ${c.delegatee}`, c] as const))(
    "%s guards the render on the fetch's own failure",
    (_label, site) => {
      expect(
        site.handled,
        `${site.caller} renders ${site.delegatee} without reading whether ITS OWN fetch failed — the ` +
          "delegated component only draws what it is handed, so this caller's failure reads as empty. " +
          "Either draw <LoadFailed> or return early on the error before this render.",
      ).toBe(true);
    },
  );

  it("says it in both locales, and the Japanese is not the English", () => {
    const en = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/en.json"), "utf8")) as Record<string, Record<string, string>>;
    const ja = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/ja.json"), "utf8")) as Record<string, Record<string, string>>;
    for (const key of ["loadFailed", "loadRetry"]) {
      expect(en.common?.[key], `en is missing common.${key}`).toBeTruthy();
      expect(ja.common?.[key], `ja is missing common.${key}`).toBeTruthy();
      expect(ja.common![key], `ja.common.${key} is still the English string`).not.toBe(en.common![key]);
    }
  });

  it("names no resource, so it cannot leak the existence of one (#227)", () => {
    const en = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/en.json"), "utf8")) as Record<string, Record<string, string>>;
    for (const word of ["page", "space", "link", "member", "permission"]) {
      expect(en.common!.loadFailed.toLowerCase(), `the sentence must not name a ${word}`).not.toContain(word);
    }
  });

  it("always offers the way back — a dead end in kinder words is still a dead end", () => {
    const view = readFileSync(resolve(SRC_ROOT, "ui/LoadFailed.tsx"), "utf8");
    expect(view).toContain("common.loadFailed");
    expect(view).toContain("common.loadRetry");
    expect(view).toMatch(/-retry[\s\S]{0,120}onClick=\{onRetry\}/);
  });
});
