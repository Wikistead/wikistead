// #873 (review rejection), carried forward by #979 / ADR-268 ruling a notice band has to say what
// kind it is.
//
// THE ORIGINAL DEFECT: `UnsavedBanner` wore the `wks-left-bar` CSS class and never set its colour
// token, so the strip took the rule's default (`var(--wks-left-bar-color, var(--accent))`, blue) while
// its own border was `--danger` and its own comment said the strip was too — a band that shipped
// looking like ordinary information while announcing that edits were not reaching the server.
//
// #979 replaced the class with `<NoticeBand kind="danger" | "info">` — `kind` is now a REQUIRED
// TypeScript prop with no fallback value anywhere in the component (ui/NoticeBand.tsx), so the literal
// #873 shape (a band that renders SOMETHING plausible with no colour chosen) cannot compile. Ruling
// asked for this pin to be REBUILT on the new mechanism rather than deleted — a walk that still
// judges every site and goes red on zero sites found — so this file still walks every `<NoticeBand`
// JSX site rather than trusting the type system alone: the type system stops a literal omission; this
// stops a `kind={(x as any)}` cast or a future prop that ships with a default some caller forgets to
// override, the same "unstated token" shape one level up.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..");
const KNOWN_KINDS = ["danger", "info"]; // ui/NoticeBand.tsx's NoticeBandKind union — kept in sync manually, asserted below

/** Extract the className a call site passes, when it does — null when the attribute is absent. */
function customRadiusOrPadding(tag: string): string | null {
  const m = /\bclassName=(["'])([^"']*)\1/.exec(tag);
  if (!m) return null;
  return m[2].split(/\s+/).find((c) => /^(rounded-|px-|py-)/.test(c)) ?? null;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) && !/NoticeBand\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * Every `<NoticeBand ...>` opening tag in the tree (the tag's own text, not the whole file — a
 * neighbouring element's `kind` must not be able to excuse this one, the exact #873 shape one level up).
 */
function noticeBandSites(): { where: string; tag: string }[] {
  const sites: { where: string; tag: string }[] = [];
  for (const path of walk(SRC)) {
    const src = readFileSync(path, "utf8");
    for (const m of src.matchAll(/<NoticeBand\b[\s\S]*?>/g)) {
      const before = src.slice(0, m.index!);
      const line = before.split("\n").length;
      sites.push({ where: `${relative(SRC, path)}:${line}`, tag: m[0] });
    }
  }
  return sites;
}

describe("#873 / #979 a notice band names its own kind", () => {
  const sites = noticeBandSites();

  it("finds the bands at all — a scan of nothing would satisfy every assertion below", () => {
    // Measured today: six sites (LoginScreen, LocalLoginForm, SetPasswordForm, FactorStep,
    // AdminAuthTab, UpgradeNotice). Asserted loosely — bands come and go — but zero is the state
    // where this file would be reporting on a tree it never read.
    expect(sites.length, "no <NoticeBand> element found — the walk is measuring nothing").toBeGreaterThan(0);
  });

  // The line above KNOWN_KINDS claims it is "asserted below" — until now nothing did, so a kind added
  // to NoticeBandKind (ui/NoticeBand.tsx) without a matching KNOWN_KINDS update would silently pass
  // every call-site check above instead of surfacing the drift.
  it("KNOWN_KINDS matches NoticeBand.tsx's NoticeBandKind union", () => {
    const src = readFileSync(join(SRC, "ui/NoticeBand.tsx"), "utf8");
    const m = /export type NoticeBandKind = ([^;]+);/.exec(src);
    expect(m, "NoticeBandKind union not found — update this regex if the type moved").not.toBeNull();
    const declared = m![1].split("|").map((s) => s.trim().replace(/^"|"$/g, "")).sort();
    expect(declared, "KNOWN_KINDS above is stale against NoticeBand.tsx's actual union").toEqual([...KNOWN_KINDS].sort());
  });

  it.each(sites.map((s) => [s.where, s.tag] as const))(
    "%s declares a known kind",
    (where, tag) => {
      const m = /\bkind=(["'])(\w+)\1/.exec(tag);
      expect(m, `${where} does not state kind= as a plain string literal — the scan cannot see what it renders as`).not.toBeNull();
      expect(KNOWN_KINDS, `${where} declares kind="${m?.[2]}", not one of NoticeBand's declared kinds`).toContain(m?.[2]);
    },
  );

  // ⚠️ break-check: this scan reads the JSX TEXT, not the compiled prop — prove it actually rejects a
  // site with no kind= at all, the same shape #873's original defect was (a band with nothing chosen).
  it("⚠️ break-check: a NoticeBand tag with no kind= at all is refused, not silently passed", () => {
    const bare = '<NoticeBand title="x" testId="y">body</NoticeBand>';
    const m = /\bkind=(["'])(\w+)\1/.exec(bare);
    expect(m, "a tag missing kind= must not match — this is the #873 shape the scan exists to catch").toBeNull();
  });

  // ADR-268 §5's acceptance: a second call site writing its own radius/padding must go red. NoticeBand
  // passes `className` straight through with no check of its own (ui/NoticeBand.tsx), so a caller can
  // silently override the shared rounded-lg/px-3.5/py-3 shape ADR-268 asked every site to share — the
  // same "unstated override" family #873's kind= check exists for, one prop over.
  it.each(sites.map((s) => [s.where, s.tag] as const))(
    "%s does not override the shared radius/padding",
    (where, tag) => {
      const bad = customRadiusOrPadding(tag);
      expect(bad, `${where} passes className="${bad}" — radius/padding is NoticeBand's shared shape (ADR-268 §5), not a per-site choice`).toBeNull();
    },
  );

  // ⚠️ break-check: prove the className scan actually rejects a site that overrides the shape, not just
  // one missing kind=.
  it("⚠️ break-check: a NoticeBand tag with its own rounded-/px-/py- class is refused, not silently passed", () => {
    const overridden = '<NoticeBand kind="danger" title="x" testId="y" className="rounded-md">body</NoticeBand>';
    expect(customRadiusOrPadding(overridden), "a className with rounded-/px-/py- must not pass — this is the ADR-268 §5 shape the scan exists to catch").not.toBeNull();
  });
});
