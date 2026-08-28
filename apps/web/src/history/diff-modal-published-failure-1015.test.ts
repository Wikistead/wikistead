// #1015: `usePublished`'s own failure hit the shape 468d002d already closed for `useRevisionContent`
// — `published?.publishedMd ?? ""` read a failed fetch the same as a real, empty published body. Fed
// into `sideBySide(oldContent, "")`, that renders a diff where every line of the real revision is a
// deletion: a network hiccup looks exactly like the whole page body was removed.
//
// No `@testing-library/react` in this package (a new dependency needs a licence gate + review), so —
// same as spaces-move-destination-failure-985.test.ts and SpacePagesTab's own #1.4 pin — this reads
// the source: DiffModal's JSX is a flat `&&`-gated chain, so source order and the guard's own boolean
// expression ARE the render-branch logic, not a rendering detail this text-level test would miss.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(import.meta.dirname, "./DiffModal.tsx"), "utf8");

describe("#1015 a failed published fetch is not an empty published body", () => {
  it("usePublished's own isError is destructured and named", () => {
    expect(SRC, "must read usePublished's own isError").toMatch(
      /const \{ data: published, isError: publishedIsError, refetch: refetchPublished \} = usePublished\(pageId\);/,
    );
  });

  it("the failure branch reads BOTH queries' isError, not just useRevisionContent's", () => {
    const line = /\{!isLoading && \(([^)]+)\) && \(/.exec(SRC)?.[1];
    expect(line, "the failure gate must exist").toBeTruthy();
    expect(line, "must still read the revision content's own failure").toContain("isError");
    expect(line, "must also read the published fetch's own failure").toContain("publishedIsError");
  });

  it("both the no-changes and the diff-grid branches exclude publishedIsError — a failure can reach neither", () => {
    const noChanges = /\{!isLoading && ([^}]+) && <p[^>]*data-testid="diff-no-changes"/.exec(SRC)?.[1];
    const diffGrid = /\{!isLoading && ([^}]+) && \(\s*<div data-testid="diff-grid"/.exec(SRC)?.[1];
    expect(noChanges, "the no-changes branch's guard must exist").toBeTruthy();
    expect(diffGrid, "the diff-grid branch's guard must exist").toBeTruthy();
    expect(noChanges, "no-changes must not fire on a failed published fetch").toContain("!publishedIsError");
    expect(diffGrid, "diff-grid must not fire on a failed published fetch").toContain("!publishedIsError");
  });

  it("the failure branch is drawn before the no-changes/diff-grid branches in source order", () => {
    const failedAt = SRC.indexOf('<LoadFailed\n            testId="diff-failed"');
    const noChangesAt = SRC.indexOf('data-testid="diff-no-changes"');
    const diffGridAt = SRC.indexOf('data-testid="diff-grid"');
    expect(failedAt, "the failure branch exists").toBeGreaterThan(-1);
    expect(failedAt, "...before no-changes").toBeLessThan(noChangesAt);
    expect(failedAt, "...before diff-grid").toBeLessThan(diffGridAt);
  });

  it("retry wires to both queries' own refetch", () => {
    expect(SRC).toMatch(/onRetry=\{\(\)\s*=>\s*\{\s*void refetch\(\);\s*void refetchPublished\(\);\s*\}\}/);
  });

  it("uses the shared #888 copy — no bespoke wording for the same fact", () => {
    expect(SRC, "must render the shared LoadFailed component, not bespoke markup").toMatch(/<LoadFailed\s*\n\s*testId="diff-failed"/);
  });

  // Both directions in one break-check: strip exactly the text this fix inserted (the `publishedIsError`
  // disjunct in the failure gate, and its two `!publishedIsError` conjuncts) and confirm what's left is
  // the pre-fix bug — a published-fetch failure with `isError` (revision) false falls straight through
  // to the no-changes/diff-grid branches, guarded only by `changed`, which itself goes false because
  // `sideBySide(oldContent, published?.publishedMd ?? "")` reads the failed fetch as an empty body.
  it("⚠️ break-check: removing publishedIsError leaves the published fetch's failure unguarded", () => {
    const failureGate = "{!isLoading && (isError || publishedIsError) && (";
    const noChangesGate = '{!isLoading && !isError && !publishedIsError && !changed && <p className="text-sm text-muted-foreground" data-testid="diff-no-changes">{t("history.noChanges")}</p>}';
    const diffGridGate = "{!isLoading && !isError && !publishedIsError && changed && (";
    expect(SRC, "the exact failure-gate text must still be present, unmodified").toContain(failureGate);
    expect(SRC, "the exact no-changes-gate text must still be present, unmodified").toContain(noChangesGate);
    expect(SRC, "the exact diff-grid-gate text must still be present, unmodified").toContain(diffGridGate);

    const withoutFix = SRC
      .replace(failureGate, "{!isLoading && isError && (")
      .replace(noChangesGate, noChangesGate.replace(" && !publishedIsError && !changed", " && !changed"))
      .replace(diffGridGate, "{!isLoading && !isError && changed && (");
    expect(withoutFix, "the mutation actually changed the source").not.toBe(SRC);
    expect(withoutFix, "usePublished's isError no longer gates any branch").not.toContain("publishedIsError &&");
    expect(withoutFix, "...and the no-changes/diff-grid branches are still there, now reachable on a failed published fetch")
      .toMatch(/!isLoading && !isError && !changed/);
  });

  it("a genuinely empty (successfully fetched) published body is unaffected — !changed still reaches no-changes", () => {
    // The reciprocal direction: the fix adds a disjunct/conjunct on FAILURE, it does not touch the
    // `changed` computation at all, so a real empty draft (published.publishedMd === "", isError false)
    // still falls through publishedIsError (false) into the existing !changed branch exactly as before.
    expect(SRC, "changed is still derived from rowsHaveChanges(rows), untouched by this fix").toContain(
      "const changed = rowsHaveChanges(rows);",
    );
    expect(SRC, "rows is still derived from the real published content, not short-circuited on success").toContain(
      'sideBySide(oldContent, published?.publishedMd ?? "")',
    );
  });
});
