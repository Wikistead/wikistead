// #578 (review rejection, 2026-08-05): a principal the product cannot name must not be shown as its id.
//
// The reject is explicit about the SHAPE of this pin, and about why the previous one was not enough
//
//
// It was right: of the four surfaces, the page permissions dialog used `?? a.principal.replace(...)`
// and a grep for `|| sub` never saw it. So the scan asks the question the defect is about — **which
// files turn a subject id into something a person reads, and does each of them have an answer for the
// case where it resolves to nothing** — rather than looking for one spelling of the bug.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { memberLabel, shortPrincipalId } from "./principal-label";

const SRC = resolve(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Every source file that strips the `user:` prefix — i.e. turns a principal into a bare subject id. */
function filesThatUnwrapAPrincipal(): { path: string; src: string }[] {
  return walk(SRC)
    .map((path) => ({ path, src: readFileSync(path, "utf8") }))
    .filter(({ src }) => /replace\(\/\^user:\//.test(src));
}

describe("#578: a person who cannot be named is named as unnamed, not as a hash", () => {
  it("the scan finds the files that unwrap a principal (a broken pattern must not pass vacuously)", () => {
    const files = filesThatUnwrapAPrincipal();
    expect(files.length, "at least the surfaces the reject listed").toBeGreaterThanOrEqual(3);
  });

  it("every file that unwraps a principal has an answer for an unresolvable one", () => {
    // The question, asked of the code rather than of a spelling. A file that reduces a principal to its
    // id is about to show it to somebody; if it never reaches the shared label, it has no answer for the
    // case where the name is missing — which is exactly the four surfaces this ticket found.
    const missing = filesThatUnwrapAPrincipal()
      .filter(({ src }) => !/memberLabel\s*\(/.test(src))
      // A file may show a bare id ON PURPOSE — the audit ledger records WHO acted, and the id is the
      // record. Those say so with a marker next to the line, rather than in a list somewhere else, the
      // same discipline `fga-read-ok:` uses (#574). A file with no name resolution and no marker is the
      // defect this ticket is about.
      .filter(({ src }) => !/raw-principal-ok:/.test(src))
      .filter(({ src }) => !/shortPrincipalId\s*\(/.test(src))
      .map(({ path }) => path.slice(SRC.length + 1));
    expect(
      missing,
      `these files turn a principal into a bare id and never reach memberLabel (#578). Use it, or ` +
      `annotate the line with \`// raw-principal-ok: <why a bare id is right here>\`: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("no surface falls back to the bare id with `||` or `??`", () => {
    // The narrower check the reject started from, kept because it is cheap and names the exact shape
    // that shipped four times. It is NOT the main assertion — the one above is — but a regression here
    // is worth its own message.
    const offenders = walk(SRC)
      .filter((p) => !/\.test\.tsx?$/.test(p))
      // Per LINE, not per file: one annotated line must not excuse an unannotated one three lines
      // down. Comments are stripped from the rest so a note ABOUT the old shape is not read as the
      // old shape — except the annotation itself, which is what marks the line as deliberate.
      .map((p) => ({
        p,
        m: readFileSync(p, "utf8").split("\n")
          .filter((line) => !/raw-principal-ok:/.test(line))
          .map((line) => line.replace(/\/\/[^\n]*/g, ""))
          .filter((line) => /(\|\||\?\?)\s*(sub|principal)\s*(?![.:\w])/.test(line)),
      }))
      .filter(({ m }) => m && m.length > 0)
      .map(({ p }) => p.slice(SRC.length + 1));
    expect(offenders, `a raw subject id is used as a display fallback: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the label says the name is unknown and keeps enough id to tell two orphans apart", () => {
    const long = "89e72bb9f2d5effccbf6fe2784f01fe06057f960f06ccb109ef4a0cdef17791c";
    expect(memberLabel(long, null, "unknown member")).toBe("unknown member (89e72bb9…)");
    // two different orphans must not read as the same row
    expect(memberLabel(long, null, "x")).not.toBe(memberLabel(`ff${long.slice(2)}`, null, "x"));
  });

  it("a resolved name wins, and a blank one does not", () => {
    expect(memberLabel("abc1234567890", "Ada", "unknown member")).toBe("Ada");
    // a members row with display_name = '' would otherwise render as an empty cell
    expect(memberLabel("abc1234567890", "   ", "unknown member")).toBe("unknown member (abc12345…)");
    expect(memberLabel("abc1234567890", undefined, "unknown member")).toBe("unknown member (abc12345…)");
  });

  it("a short id is shown whole — truncating it would invent ambiguity", () => {
    expect(shortPrincipalId("dev-user")).toBe("dev-user");
    expect(shortPrincipalId("user:dev-user"), "the prefix is not part of the id").toBe("dev-user");
  });

  it("both locales carry the wording (a missing key renders the key)", () => {
    for (const loc of ["en", "ja"]) {
      const json = JSON.parse(readFileSync(resolve(SRC, "i18n/locales", `${loc}.json`), "utf8"));
      expect(json.spaceMembers.unknownMember, `${loc}: the noun the four surfaces share`).toBeTruthy();
      expect(json.spaceMembers.unknownGroup, `${loc}: and its group counterpart still exists`).toBeTruthy();
    }
  });

  it("the four surfaces keep their revoke — unreadable must not mean unremovable", () => {
    // The rule the group arm already followed, now that people rows can also be unresolvable. Checked at
    // the source, since the affordance is what the reject asked for (acceptance 2).
    const withRevoke: [string, string][] = [
      ["settings/SpaceMembersTab.tsx", "space-grant-revoke"],
      ["ui/PermissionsDialog.tsx", "grant-role-revoke"],
    ];
    for (const [file, testId] of withRevoke) {
      expect(readFileSync(resolve(SRC, file), "utf8"), `${file} keeps its revoke affordance`).toContain(testId);
    }
  });
});
