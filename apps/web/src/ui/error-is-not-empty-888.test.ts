// #888: a list that could not be fetched is not an empty list.
//
// THE DEFECT: react-query's `isLoading` goes false the moment a request settles, success or not, and
// `data` stays undefined on failure. `!isLoading && (data?.length ?? 0) === 0` therefore renders the
// empty state for a fetch that FAILED. #500 found this on the page tree; #895 found it on twenty more
// surfaces; #933 / ADR-266 found that the PIN checking for it could itself be spelled around (§1.1's
// `componentAround` borrowing a sibling query's LoadFailed, §1.3's naming dependency, §1.5's floor).
//
// ADR-266 §3 answers that two ways
// §3.1 — a shared `<ListState>` (../ui/ListState.tsx) is the CHOKEPOINT. A surface rendered from
// inside it cannot show an empty state for a failed fetch, because it does not decide which of
// the three it is showing. This file's own check reflects that: `judgeSite` treats "rendered
// inside <ListState>" as sufficient, no identifier resolution needed.
// §3.2 — for everything not yet migrated, the checker resolves the ACTUAL query identifier an empty
// branch's condition reads (walking aliases, ternaries and destructuring one hop at a time — see
// `../ui/discovery/list-state-resolver.ts`) instead of matching a spelling or trusting a text
// window. A chain it cannot follow is RED, not silently passed.
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  walkFiles, findSites, judgeSite, isFailureGuardedBefore, type Site, type Verdict,
} from "./discovery/list-state-resolver";
import registry from "./discovery/list-state-registry.json";

const SRC_ROOT = resolve(import.meta.dirname, "..");

function parseSource(file: string, src: string): ts.SourceFile {
  return ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function passes(v: Verdict): boolean {
  return v.kind === "list-state" || v.kind === "handled" || v.kind === "vacuous" || v.kind === "ungated";
}

function describeVerdict(v: Verdict): string {
  if (v.kind === "unhandled") return `the query "${v.query}" is never guarded here`;
  if (v.kind === "give-up") return `"${v.identifier}" — ${v.reason}`;
  return v.kind;
}

// Prop-fed components: the data (and its failure) belongs to whoever renders them, not to this file.
// #895 (round 1): naming the caller in PROSE is not checking it — this table stays exactly one,
// cross-checked against every render site in the tree, never a second list nothing walks.
const DELEGATED: Record<string, { reason: string; renderPattern: RegExp; guardTokens: string[] }> = {
  "settings/ApiKeysPanel.tsx": {
    reason: "keys arrive as a prop — AccountPage and AdminApiTab own the fetch",
    renderPattern: /<ApiKeysPanel\b/,
    guardTokens: ["keys.isError", "keys.error"],
  },
  "app/HomeEmpty.tsx": {
    reason: "presentational: HomeLanding decides there are no spaces and renders this",
    renderPattern: /<HomeEmpty\b/,
    guardTokens: ["spaces.isError", "spaces.error"],
  },
};

// ADR-266 §3.3: "NOT_A_FETCH's file entries become site entries" — verified BY HAND, once, that the
// key answers no query at all (or that the caller already forecloses the failure before this ever
// renders). Not a residue entry: these are not backlog, they are the read-one-at-a-time conclusion
// §1.3 asked for.
const KNOWN_SAFE: Record<string, string> = {
  "editor/live-preview/frontmatter.ts::frontmatter.empty": "an empty frontmatter block in the open document, not a fetch",
  "editor/Editor.tsx::macro.listEmpty": "ListSource.fetch is existence-hiding by design (denied and network failure both resolve null) — see decorations.ts's ListSource doc comment",
  "app/routes.tsx::page.empty": "BodyPlaceholder's `empty`/`canEdit` are props — routes.tsx returns the page.notFound branch on pageQ.isError before BodyPlaceholder is ever rendered",
  "app/routes.tsx::page.emptyEditable": "same BodyPlaceholder props as page.empty",
  "app/HomeEmpty.tsx::home.emptySelfHostGuide": "deliberately fails closed — `entitlements.data?.selfHosted === true` reads false on a failed/unanswered fetch just as it does on a real 'no', and the in-file comment records that this is chosen, not missed (guessing would put a self-host link in front of a paying tenant)",
  // #1016: fixed by walking a plain call's arguments — these three surfaced only because the resolver
  // can now see far enough to notice it still cannot verify them (a custom hook, or a hop through one).
  "app/LoginScreen.tsx::auth.noMethods": "`useLoginOptions`'s own definition swallows a failed fetch to `{ methods: [\"oidc\"] }` by design — its in-file comment records the fail-open DISPLAY choice (the buttons it draws are still server-refused URLs) as deliberate, not missed",
  "app/routes.tsx::publicPage.notFound": "the PublicSpaceRoute occurrence reads `treeVerdict = loadVerdict(lazy.root.isError, lazy.root.error)` — a direct `.isError`/`.error` check on `usePublicLazyTree`'s own `root` query, one hop through a custom hook the resolver does not open",
  "settings/RecoveryCodesPanel.tsx::account.recoveryNoProof": "reached only past two guards: the `set.isError` arm one level up already excludes a failed status fetch (so `set.data?.hasPassword` is live here), and `hasFactor` (from `factors.data`) is true — a failed `factors` fetch reads `hasFactor` false and diverts to `account.recoveryNeedsFactor` first; `browserCanUseFactorKind(\"passkey\")` is the one truly query-free input, a synchronous `window`/`PublicKeyCredential` capability check",
  // #1016 (corrected 2026-08-28, independent review): the resolver classified this RESIDUE
  // because `changed` is bound via `useMemo` over `rowsHaveChanges(rows)` — but the site's actual
  // safety does not depend on that chain. The gate that draws `history.noChanges` is
  // `!isLoading && !isError && !publishedIsError && !changed`, and both `isError` (useRevisionContent)
  // and `publishedIsError` (usePublished, #1015) are destructured and read directly in that same gate
  // expression, ahead of and independent of whatever `changed` resolves to.
  // #1056 landed a SECOND occurrence of this key: `notify.error(t("members.noAddressForLink"))` inside
  // `catch (e)` on the enablePassword mutation, so the resolver walks back to `e` — the caught error
  // and reports "declared with no initializer". There is no query behind it to guard: the toast fires
  // only on that mutation's own rejection, which is the failure #933 asks a give-up to be tied to. The
  // key is shared with the empty-state occurrence on purpose (an address-less deployment gets the same
  // sentence the invite dialog gives), and that occurrence resolves on its own.
  "settings/MembersPage.tsx::members.noAddressForLink": "the give-up occurrence is a mutation's error toast — `catch (e)` on `enablePassword`, where the identifier the resolver lands on is the caught error, not a query; it cannot render on a successful-but-empty read at all",
  "history/DiffModal.tsx::history.noChanges": "the no-changes gate is `!isLoading && !isError && !publishedIsError && !changed` — `isError` and `publishedIsError` are read directly in the gate itself (#1015), so a failed fetch never reaches this branch regardless of what `changed` (the part the resolver cannot trace through `useMemo`) evaluates to",
};

// ADR-266 §3.3 (the owner's #759 ruling this reuses): the surfaces the checker cannot yet clear
// are a PRINTED, COUNTED residue — not a silent exemption. Each entry is one `file::key` the resolver
// currently cannot verify (a custom hook it does not recognise, a helper parameter, a hook whose
// return shape is not react-query's). A site NOT in this list that comes back unhandled/give-up fails
// its own assertion below — this table only widens what a NAMED, tracked site is allowed to be.
const RESIDUE: Record<string, string> = {
  // #1016: `kind` is the enrolment-step-helper parameter this entry already named; `kinds` is the
  // OTHER occurrence's own prop, reached through `doorProofs(kinds, webauthn)` now that a plain call's
  // arguments are walked — same "the fetch belongs to the caller" shape, not independently verified.
  "app/FactorStep.tsx::auth.factorNoWebauthn": "`kind` is a parameter of a small enrolment-step helper, not a query; the other occurrence's `proofs = doorProofs(kinds, webauthn)` reads the `kinds` prop the same way — not independently verified this session",
  "app/PageViewsChart.tsx::pageAnalytics.noViews": "bound via `useMemo` over query data — the resolver does not trace into a callback body",
  // #1016: `pages` is a prop reached through `buildTree(pages)` now that a plain call's arguments are
  // walked — the fetch's failure belongs to whoever renders this component, not to this file. Same
  // "prop-fed" shape as DELEGATED, but not cross-checked against every render site the way that table
  // requires (#895 naming a specific caller in prose here is not a check) — so it stays here.
  "app/GuestSidebar.tsx::share.spaceEmpty": "`tree = buildTree(pages)` reads the `pages` prop — the fetch's failure belongs to whoever renders this component, not to this file; not independently verified against every caller, and `error` was optional (now required, closing the silent-omission gap)",
  "app/RecentChangesPage.tsx::recentChanges.empty": "`useFeed` is a custom hook, not imported from a queries module",
  "attachments/AttachmentsPanel.tsx::attachments.empty": "`useAttachments` is a custom hook, not imported from a queries module",
  "notifications/WatchListPage.tsx::watches.empty": "`useWatchList` is a custom hook, not imported from a queries module",
  "settings/AdminAuditTab.tsx::transparency.empty": "a raw `useQuery(...)` call, bypassing the `data/queries` module the resolver keys off",
  "settings/AdminSignInMethodsSection.tsx::adminAuth.secondFactorNoAdmin": "one occurrence is a `refusalText(code)` helper parameter; the other traces through `methods` via the `m &&` outer gate (a `.data`-truthiness guard, not a literal `.isError`) — plausibly already safe, not independently verified this session",
  "settings/AdminSignInMethodsSection.tsx::adminAuth.ssoExemptionNoCredential": "`x` is a `.map` callback parameter (a member row), not a query",
  "settings/ConnectionsLinkPanel.tsx::account.connectionNoProof": "`methods` here is a local computed value the resolver could not find a declaration for — not independently verified this session",
  "sidebar/Sidebar.tsx::sidebar.noSpaces": "bound via `useMemo` over query data — the resolver does not trace into a callback body (by hand: `spacesQ.isError` is checked above this branch)",
  "sidebar/Sidebar.tsx::sidebar.noPages": "bound via `useMemo` over query data (by hand: `pagesQ.isError` is checked above this branch)",
  "sidebar/SpaceSwitcher.tsx::sidebar.noSpacesMatch": "bound via `useMemo` over query data — the resolver does not trace into a callback body",
};

const sites: (Site & { verdict: Verdict })[] = [];
for (const file of walkFiles(SRC_ROOT)) {
  const src = readFileSync(file, "utf8");
  const rel = file.slice(SRC_ROOT.length + 1);
  const found = findSites(rel, src);
  if (found.length === 0) continue;
  const sf = parseSource(file, src);
  for (const site of found) sites.push({ ...site, verdict: judgeSite(sf, site) });
}

interface CallSite { caller: string; delegatee: string; guarded: boolean }
const callSites: CallSite[] = [];
for (const [delegatee, { renderPattern, guardTokens }] of Object.entries(DELEGATED)) {
  for (const file of walkFiles(SRC_ROOT)) {
    const rel = file.slice(SRC_ROOT.length + 1);
    if (rel === delegatee) continue;
    const src = readFileSync(file, "utf8");
    if (!renderPattern.test(src)) continue;
    const sf = parseSource(file, src);
    for (const m of src.matchAll(new RegExp(renderPattern.source, "g"))) {
      callSites.push({ caller: rel, delegatee, guarded: isFailureGuardedBefore(sf, m.index!, guardTokens) });
    }
  }
}

describe("#933 / ADR-266 the checker resolves the query an empty branch reads, not its spelling", () => {
  // ⚠️ #719 / #1.5: a floor recorded BESIDE the walk (list-state-registry.json), not typed into the
  // assertion — deleting a real empty-state surface drops `sites.length` below the recorded floor and
  // this goes red, which a fixed `>= 20` could not do once the tree outgrew twenty.
  it(`finds ${sites.length} empty-state surfaces (floor ${registry.floor}, from the previous run)`, () => {
    expect(sites.length, `no empty-state surfaces found under ${SRC_ROOT}`).toBeGreaterThanOrEqual(registry.floor);
  });

  it("keeps KNOWN_SAFE and DELEGATED live", () => {
    for (const key of Object.keys(KNOWN_SAFE)) {
      const [file, k] = key.split("::") as [string, string];
      expect(existsSync(resolve(SRC_ROOT, file)), `${file} is gone — drop the KNOWN_SAFE entry ${key}`).toBe(true);
      expect(sites.some((s) => s.file === file && s.key === k), `${key} no longer matches a discovered site — drop the entry`).toBe(true);
    }
    for (const rel of Object.keys(DELEGATED)) {
      expect(existsSync(resolve(SRC_ROOT, rel)), `${rel} is gone — drop the DELEGATED entry`).toBe(true);
    }
  });

  it.each(sites.map((s) => [`${s.file}:${s.key} (${s.verdict.kind})`, s] as const))(
    "%s is compliant, prop-delegated, or an explicitly tracked residue entry",
    (_label, s) => {
      if (s.file in DELEGATED) return; // the caller owns it — checked by the call-site suite below
      if (passes(s.verdict)) return;
      const knownSafe = `${s.file}::${s.key}` in KNOWN_SAFE;
      const residue = `${s.file}::${s.key}` in RESIDUE;
      expect(
        knownSafe || residue,
        `${s.file}:${s.key} — ${describeVerdict(s.verdict)}. Either draw <LoadFailed> guarding that ` +
          "query (or migrate onto <ListState>), or add it to RESIDUE with why the resolver cannot see it yet.",
      ).toBe(true);
    },
  );

  it("finds at least one render site for every delegated component (the walk is not vacuous)", () => {
    for (const delegatee of Object.keys(DELEGATED)) {
      expect(
        callSites.some((c) => c.delegatee === delegatee),
        `${delegatee} is in DELEGATED but no caller renders it — the render pattern broke, or it has no callers left (drop the entry)`,
      ).toBe(true);
    }
  });

  it.each(callSites.map((c) => [`${c.caller} renders ${c.delegatee}`, c] as const))(
    "%s guards the render on the fetch's own failure",
    (_label, c) => {
      expect(
        c.guarded,
        `${c.caller} renders ${c.delegatee} without a guard the checker can find on ${DELEGATED[c.delegatee]!.guardTokens.join("/")} ` +
          "before this render — the delegated component only draws what it is handed, so this caller's failure reads as empty.",
      ).toBe(true);
    },
  );

  // ADR-266 §3.3 / #759 printed and counted every run, RED if it grows. When this reaches zero
  // the table above, this describe block's residue tests, and `residueCeiling` in the registry all get
  // deleted together — a run that finds nothing here should read as "the debt is gone", not silently
  // say nothing the way #1.6's file-level exemptions did.
  const residueCount = sites.filter((s) => !passes(s.verdict) && `${s.file}::${s.key}` in RESIDUE).length;
  it(`residue: ${residueCount} known non-compliant site(s) (ceiling ${registry.residueCeiling})`, () => {
    if (residueCount === 0) {
      // eslint-disable-next-line no-console
      console.log("residue is empty — delete RESIDUE, this test and residueCeiling from the registry");
    }
    expect(residueCount, "the residue grew — fix the new site, or name it here with why").toBeLessThanOrEqual(registry.residueCeiling);
  });

  it("every RESIDUE entry still matches a live, still-noncompliant site", () => {
    for (const key of Object.keys(RESIDUE)) {
      const [file, k] = key.split("::") as [string, string];
      const matching = sites.filter((s) => s.file === file && s.key === k);
      expect(matching.length, `${key} matches no discovered site — drop the entry`).toBeGreaterThan(0);
      expect(matching.some((s) => !passes(s.verdict)), `${key} is now fully compliant — drop the entry`).toBe(true);
    }
  });
});

// ADR-266 §1.1, reproduced both directions. RelatedPanel is migrated onto <ListState> now (its own
// LoadFailed ternary is gone), so the historical three-queries-one-function shape is reproduced as a
// fixture rather than by mutating a file that no longer has that text — the point under test is the
// RESOLVER's behaviour on that shape, which is exactly what let #895 round 4 through in the first
// place. AdminRolesTab still carries the real ternary, so that half mutates the real file.
describe("#1.1 a sibling query's LoadFailed cannot cover this query's own failure", () => {
  const threeQueryShape = (guardMiniGraph: boolean): string => `
    import { useTranslation } from "react-i18next";
    import { LoadFailed } from "../ui/LoadFailed";
    import { useBacklinks, useLocalGraph, useRelated } from "../data/queries";
    export function RelatedPanelLike({ pageId }: { pageId: string }) {
      const { t } = useTranslation();
      const { data, isError: backlinksFailed, refetch: refetchBacklinks } = useBacklinks(pageId);
      const backlinks = data ?? [];
      const related = useRelated(pageId);
      const relatedGroups = related.data?.groups ?? [];
      const miniGraph = useLocalGraph(pageId, 1, true);
      return (
        <div>
          {backlinksFailed ? <LoadFailed onRetry={() => { void refetchBacklinks(); }} /> : backlinks.length === 0 ? <p>{t("backlinks.empty")}</p> : <ul />}
          {related.isError ? <LoadFailed onRetry={() => { void related.refetch(); }} /> : relatedGroups.length === 0 ? <p>{t("related.empty")}</p> : <ul />}
          ${guardMiniGraph
            ? `{miniGraph.isError ? <LoadFailed onRetry={() => { void miniGraph.refetch(); }} /> : miniGraph.data && miniGraph.data.nodes.length > 1 ? <div /> : <p>{t("related.graphEmpty")}</p>}`
            : `{miniGraph.data && miniGraph.data.nodes.length > 1 ? <div /> : <p>{t("related.graphEmpty")}</p>}`}
        </div>
      );
    }
  `;

  function judgeFixture(src: string, key: string): Verdict {
    const sf = parseSource("RelatedPanelLike.tsx", src);
    const site = findSites("fixture/RelatedPanelLike.tsx", src).find((s) => s.key === key);
    if (!site) throw new Error(`fixture does not contain a site for ${key}`);
    return judgeSite(sf, site);
  }

  it("present: miniGraph guards its own failure — green", () => {
    expect(judgeFixture(threeQueryShape(true), "related.graphEmpty").kind).toBe("handled");
    // the SIBLING queries' own guards must still be found too — this is not "any one guard passes all"
    expect(judgeFixture(threeQueryShape(true), "backlinks.empty").kind).toBe("handled");
    expect(judgeFixture(threeQueryShape(true), "related.empty").kind).toBe("handled");
  });

  it("removed: neither sibling's LoadFailed covers it — red, and names miniGraph", () => {
    const v = judgeFixture(threeQueryShape(false), "related.graphEmpty");
    expect(v.kind).toBe("unhandled");
    if (v.kind === "unhandled") expect(v.query).toBe("miniGraph");
  });

  it("AdminRolesTab (the real file): present — green", () => {
    const file = resolve(SRC_ROOT, "settings/AdminRolesTab.tsx");
    const src = readFileSync(file, "utf8");
    const sf = parseSource(file, src);
    const site = findSites("settings/AdminRolesTab.tsx", src).find((s) => s.key === "adminRoles.customEmpty")!;
    expect(judgeSite(sf, site).kind).toBe("handled");
  });

  it("AdminRolesTab (the real file): roles.isError removed — red, and names roles", () => {
    const file = resolve(SRC_ROOT, "settings/AdminRolesTab.tsx");
    const src = readFileSync(file, "utf8");
    const mutated = src.replace(/\{roles\.isError \? \([\s\S]*?\) : \(<>/, "{(<>");
    expect(mutated, "the mutation did not apply — AdminRolesTab's guard text moved, update this pin").not.toBe(src);
    const sf = parseSource(file, mutated);
    const site = findSites("settings/AdminRolesTab.tsx", mutated).find((s) => s.key === "adminRoles.customEmpty")!;
    const v = judgeSite(sf, site);
    expect(v.kind).toBe("unhandled");
    if (v.kind === "unhandled") expect(v.query).toBe("roles");
  });
});

// ADR-266 §1.4: fixed in 65e2911b, ahead of this ticket landing (it names ADR-266 §1.4 in its own
// comment) — `moveIsError`/`moveRefetch` are drawn before `moveNoTargets` can render. This pin exists
// so the checker's OWN break-check covers it, per the acceptance note: removing either guard must
// name the query, not the file.
describe("#1.4 SpacePagesTab's move-destination guard", () => {
  const file = resolve(SRC_ROOT, "settings/SpacePagesTab.tsx");
  const src = readFileSync(file, "utf8");

  it("is already fixed in this checkout", () => {
    const sf = parseSource(file, src);
    const site = findSites("settings/SpacePagesTab.tsx", src).find((s) => s.key === "spacePages.moveNoTargets")!;
    const v = judgeSite(sf, site);
    expect(v.kind).toBe("handled");
    if (v.kind === "handled") {
      expect(v.queries).toContain("moveSearch");
      expect(v.queries).toContain("spaces");
    }
  });

  it("break-check: removing the moveSearch arm of moveIsError goes red and names moveSearch", () => {
    const mutated = src.replace(
      /const moveIsError = moveFilter\.trim\(\) \? moveSearch\.isError : spaces\.isError;/,
      "const moveIsError = spaces.isError;",
    );
    expect(mutated, "the mutation did not apply — update this pin's text to match the source").not.toBe(src);
    const sf = parseSource(file, mutated);
    const site = findSites("settings/SpacePagesTab.tsx", mutated).find((s) => s.key === "spacePages.moveNoTargets")!;
    const v = judgeSite(sf, site);
    expect(v.kind).toBe("unhandled");
    if (v.kind === "unhandled") expect(v.query).toBe("moveSearch");
  });

  it("break-check: removing the spaces arm of moveIsError goes red and names spaces", () => {
    const mutated = src.replace(
      /const moveIsError = moveFilter\.trim\(\) \? moveSearch\.isError : spaces\.isError;/,
      "const moveIsError = moveSearch.isError;",
    );
    expect(mutated, "the mutation did not apply — update this pin's text to match the source").not.toBe(src);
    const sf = parseSource(file, mutated);
    const site = findSites("settings/SpacePagesTab.tsx", mutated).find((s) => s.key === "spacePages.moveNoTargets")!;
    const v = judgeSite(sf, site);
    expect(v.kind).toBe("unhandled");
    if (v.kind === "unhandled") expect(v.query).toBe("spaces");
  });
});

// ADR-266 §3.2's give-up path, as a FIXTURE — not a unit test of inputs the resolver already knows
// how to handle, which is how every round in #1.2 passed its own review.
describe("#3.2 the resolver gives up loudly on a chain it cannot follow", () => {
  const dir = resolve(import.meta.dirname, "discovery/__fixtures__/give-up");

  it("names the unresolved identifier instead of passing", () => {
    const files = walkFiles(dir);
    expect(files.length, "the give-up fixture is missing").toBeGreaterThan(0);
    const found = files.flatMap((f) => findSites(f, readFileSync(f, "utf8")));
    expect(found.length).toBe(1);
    const file = files[0]!;
    const src = readFileSync(file, "utf8");
    const sf = parseSource(file, src);
    const v = judgeSite(sf, found[0]!);
    expect(v.kind).toBe("give-up");
    if (v.kind === "give-up") expect(v.identifier).toBe("useWidgetItems");
  });
});

// #1016: a plain (non-`use`-prefixed) function call used to drop its own ARGUMENTS on the floor
// `visible(backlinks.data ?? [])` read as `vacuous` (nothing to check) no matter what the argument
// carried, guarded or not. Three fixtures in one file, each a real site `judgeSite` runs against.
describe("#1016 a plain call's arguments are walked, not dropped", () => {
  const dir = resolve(import.meta.dirname, "discovery/__fixtures__/call-args");
  const file = resolve(dir, "Surface.tsx");
  const src = readFileSync(file, "utf8");
  const sf = parseSource(file, src);
  const rel = "discovery/__fixtures__/call-args/Surface.tsx";

  it("resolves through the helper to the query it wraps, when guarded — handled, not vacuous", () => {
    const site = findSites(rel, src).find((s) => s.key === "backlinks.empty")!;
    const v = judgeSite(sf, site);
    expect(v.kind).toBe("handled");
    if (v.kind === "handled") expect(v.queries).toContain("backlinks");
  });

  it("resolves through the helper to the query it wraps, when NOT guarded — unhandled, not vacuous", () => {
    const site = findSites(rel, src).find((s) => s.key === "related.empty")!;
    const v = judgeSite(sf, site);
    expect(v.kind).toBe("unhandled");
    if (v.kind === "unhandled") expect(v.query).toBe("backlinks");
  });

  it("a zero-argument opaque call gives up loudly instead of reading as vacuous", () => {
    const site = findSites(rel, src).find((s) => s.key === "related.graphEmpty")!;
    const v = judgeSite(sf, site);
    expect(v.kind).toBe("give-up");
    if (v.kind === "give-up") expect(v.identifier).toBe("opaqueRows");
  });
});

// #719: a walk that finds nothing because it is broken must not look identical to a walk that
// correctly found nothing. Asserted by pointing the walk at a fixture tree, not by reading the code.
describe("#719 the walk itself is not vacuously green", () => {
  it("an empty fixture tree yields zero sites", () => {
    const dir = resolve(import.meta.dirname, "discovery/__fixtures__/empty-tree");
    const files = walkFiles(dir);
    expect(files.length).toBeGreaterThan(0); // the fixture file itself must exist
    const found = files.flatMap((f) => findSites(f, readFileSync(f, "utf8")));
    expect(found.length).toBe(0);
  });

  it("the real tree is not also zero — the floor assertion above is not vacuous either", () => {
    expect(sites.length).toBeGreaterThan(0);
  });
});

// ADR-266 §3.4: the floor tracks what the walk finds, so deleting a real surface has to be visible in
// the count the walk itself produces — checked here on a controlled pair of fixtures rather than by
// mutating the live registry during a test run.
describe("#3.4 the count the walk finds reflects the tree, not a typed number", () => {
  it("the fixture with two empty-state keys reports two", () => {
    const dir = resolve(import.meta.dirname, "discovery/__fixtures__/counting/full");
    const found = walkFiles(dir).flatMap((f) => findSites(f, readFileSync(f, "utf8")));
    expect(found.length).toBe(2);
  });

  it("deleting one from the tree drops the count the walk reports", () => {
    const dir = resolve(import.meta.dirname, "discovery/__fixtures__/counting/reduced");
    const found = walkFiles(dir).flatMap((f) => findSites(f, readFileSync(f, "utf8")));
    expect(found.length).toBe(1);
  });
});

describe("#888 a failed fetch is not an empty list", () => {
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

  // #975: the Japanese used to be a literal translation of the English, including its second sentence
  // ("It is a problem here, not with what you are looking at.") — rendered as a double negative whose
  // literal sense is "it is not that [it] does not exist". That restated what sentence one ("couldn't
  // load this") already said — "could not fetch", not "fetched and found empty" — so a reader had to
  // work through the negation to learn nothing sentence one hadn't already told them. The literal
  // phrase is quoted in the assertions below (string data, not comment prose).
  it("#975: the Japanese is not a double-negative restating what the first sentence already said", () => {
    const ja = JSON.parse(readFileSync(resolve(SRC_ROOT, "i18n/locales/ja.json"), "utf8")) as Record<string, Record<string, string>>;
    const text = ja.common!.loadFailed;
    expect(text, "the double negative this ticket removed").not.toContain("ないわけではありません");
    expect(text, "the double negative this ticket removed").not.toContain("無いわけではありません");
  });
});
