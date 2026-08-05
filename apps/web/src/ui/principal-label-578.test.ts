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

  it("every EXPRESSION that unwraps a principal has an answer for an unresolvable one", () => {
    // Per EXPRESSION, not per file. The file-level version of this check was vacuous, and measured so
    // `PermissionsDialog.tsx` calls `memberLabel` at one of its three unwrapping sites, and that single
    // call excused the other two — which went on printing 70 characters of hex in the real dialog while
    // this pin stayed green (review rejection, 2026-08-05).
    //
    // The asymmetry is what made it vacuous: the deliberate-exception marker already worked per line,
    // so a file could be forgiven wholesale for something it only did right in one place. The question
    // is asked of each site now: this expression reduces a principal to an id, so who names it?
    const missing: string[] = [];
    for (const { path, src } of filesThatUnwrapAPrincipal()) {
      if (path.endsWith("principal-label.ts")) continue; // the label itself is where the unwrapping lives
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/replace\(\/\^user:\//.test(line)) return;
        // Deliberate, and it says so where it happens: on the line, or on the one directly above it
        // JSX puts a comment above the expression it is about. ONE line, never a window: a window is how
        // `PermissionsDialog`'s single good call came to excuse two bad ones 36 lines away.
        if (/raw-principal-ok:/.test(line) || /raw-principal-ok:/.test(lines[i - 1] ?? "")) return;
        if (/memberLabel\s*\(|shortPrincipalId\s*\(/.test(line)) return; // named on the spot
        // Or the id is BOUND to a name and handed to the label a line or two later, which is how the
        // space screens read. Followed by the binding rather than by a window of lines: a fixed window
        // is how `PermissionsDialog`'s one good call came to excuse two bad ones 36 lines away.
        const bound = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(line)?.[1];
        if (bound && new RegExp(`(?:memberLabel|shortPrincipalId)\\s*\\(\\s*${bound}\\b`).test(src)) return;
        missing.push(`${path.slice(SRC.length + 1)}:${i + 1}`);
      });
    }
    expect(
      missing,
      `these expressions turn a principal into a bare id with nothing to name it (#578). Reach ` +
      `memberLabel/shortPrincipalId, or annotate THAT LINE with \`// raw-principal-ok: <why>\`: ${missing.join(", ")}`,
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
