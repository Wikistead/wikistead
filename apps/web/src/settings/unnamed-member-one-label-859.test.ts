// #859: a member the product cannot name reads the same on every screen.
//
// #578 met this on four surfaces and wrote `memberLabel` for it. The screens written afterwards did
// not use it: the roster fell back through a FIELD — `m.display_name || m.email || m.sub` — ten times
// on one page, and five more sites did the same with `c.displayName || c.sub`. The pin from #578 could
// not see any of them, because it reads a BARE identifier (`|| sub`) and a principal being unwrapped.
//
// This measures the RESULT rather than the call: a member with no name goes through the row builder
// and the label, and both have to produce the one string. Asserting that a helper exists proves
// nothing about the screens that were not calling it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildUnifiedRows } from "./tenant-role-rows";
import { memberLabel, shortPrincipalId } from "../ui/principal-label";
import { authorLabel } from "../comments/AuthorChip";
import { actorLabel } from "../notifications/feedLabels";
import { revisionAuthorLabel } from "../history/HistoryPanel";

const UNKNOWN = "Unnamed member";
const LONG = "89e72bb9f2d5effccbf6fe2784f01fe06057f960f06ccb109ef4a0cdef17791c";

describe("#859 one wording for a member with no name", () => {
  it("the roster row does not print the subject id", () => {
    const rows = buildUnifiedRows(
      [{ sub: LONG, display_name: null, email: null, role: "member", groups: null }],
      [], new Set(), [], UNKNOWN,
    );
    const row = rows.find((r) => r.kind === "user")!;
    expect(row.label, "a 64-character hex string is not a name").not.toContain(LONG);
    expect(row.label).toBe(`${UNKNOWN} (${shortPrincipalId(LONG)})`);
  });

  it("and the label a screen builds directly says exactly the same thing", () => {
    // The two paths that render an unnamed member — the row builder and a call site — must agree, or
    // the same person reads differently depending on which screen you are on. That is the defect.
    const rows = buildUnifiedRows(
      [{ sub: LONG, display_name: null, email: null, role: "member", groups: null }],
      [], new Set(), [], UNKNOWN,
    );
    expect(rows.find((r) => r.kind === "user")!.label).toBe(memberLabel(LONG, null, UNKNOWN));
  });

  it("an email still names somebody in the admin's own roster", () => {
    // The roster is the admin's, and knowing who was invited is what the column is for. Only the last
    // resort — the id — was never a name.
    const rows = buildUnifiedRows(
      [{ sub: LONG, display_name: null, email: "ada@example.test", role: "member", groups: null }],
      [], new Set(), [], UNKNOWN,
    );
    expect(rows.find((r) => r.kind === "user")!.label).toBe("ada@example.test");
  });

  it("a blank name is not a name", () => {
    const rows = buildUnifiedRows(
      [{ sub: LONG, display_name: "   ", email: null, role: "member", groups: null }],
      [], new Set(), [], UNKNOWN,
    );
    expect(rows.find((r) => r.kind === "user")!.label).toBe(`${UNKNOWN} (${shortPrincipalId(LONG)})`);
  });
});

// ── the surfaces OUTSIDE settings (#859 review rejection) ───────────────────────────────────────────
//
// The four cases above measure the roster. The reject found the same person reading as a raw id on
// their own comments, in the revision list and in the notification feed — three surfaces the ticket
// named and this file never entered. `authorLabel` ended at `return sub` and `actorLabel` at
// `actor.slice(5)`, and NEITHER is a fallback chain, so the #578 scan (which looks for `|| x.sub`)
// could not have seen them. A password invite mints `wlocal_<uuid>`: no `@`, so the initial admin
// lands in exactly that branch on their first day.
const WLOCAL = "wlocal_11111111-2222-3333-4444-555555555555";
const t = ((k: string) => (k === "notifications.guest" ? "Guest" : UNKNOWN)) as never;

describe("#859 the same wording off the settings screens", () => {
  it("the comment author chip and the revision list name them the same way as the roster", () => {
    expect(authorLabel(WLOCAL, "Guest", UNKNOWN)).toBe(memberLabel(WLOCAL, null, UNKNOWN));
    expect(authorLabel(WLOCAL, "Guest", UNKNOWN)).not.toContain(WLOCAL);
  });

  it("the revision list names an actor of an unrecognised shape, rather than printing it", () => {
    // The branch nothing reached: not `user:`-prefixed and not a guest. It used to `return createdBy`.
    expect(revisionAuthorLabel(WLOCAL, UNKNOWN, "Guest")).toBe(memberLabel(WLOCAL, null, UNKNOWN));
    expect(revisionAuthorLabel(`user:${WLOCAL}`, UNKNOWN, "Guest")).toBe(memberLabel(WLOCAL, null, UNKNOWN));
    // ...while a resolved name and a missing actor keep their own answers.
    expect(revisionAuthorLabel(null, UNKNOWN, "Guest")).toBe(UNKNOWN);
    expect(revisionAuthorLabel(`user:${WLOCAL}`, UNKNOWN, "Guest", { [WLOCAL]: { displayName: "Ada" } })).toBe("Ada");
  });

  it("the notification feed and Recent Changes do too", () => {
    expect(actorLabel(`user:${WLOCAL}`, t)).toBe(memberLabel(WLOCAL, null, UNKNOWN));
    expect(actorLabel(`user:${WLOCAL}`, t)).not.toContain(WLOCAL);
  });

  it("guests keep their own short pseudonym — this did not flatten them into members", () => {
    expect(authorLabel("anon:7f3a1b2c3d4e", "Guest", UNKNOWN)).toBe("Guest 7f3a");
    expect(actorLabel("guest:3ca39b02-d803-4362-a976-90a7b5bdc46c", t)).toBe("Guest 3ca3");
  });

  it("a member the product CAN name is still named", () => {
    expect(authorLabel("ada@example.test", "Guest", UNKNOWN)).toBe("ada");
  });
});

// ── the scan that would have caught this one ─────────────────────────────────────────────────────
//
// The #578 scan asks about a SPELLING (`|| x.sub`). Twice now the leak arrived in a shape that
// spelling does not describe, and the second time it was inside the very ticket that fixed the first.
// So ask a structural question instead: which functions in this tree turn a subject id into a string
// a person reads? Every one of them has to be in the behavioural list above. A fourth appearing later
// reddens this and names itself, rather than waiting for somebody to notice the screen.
const SRC = resolve(import.meta.dirname, "..");
const ID_PARAMS = /^(sub|actor|createdBy|authorSub|principal|grantee)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("#859 every function that turns a subject id into a label is measured above", () => {
  it("finds the label makers structurally, and the list is the one this file exercises", () => {
    const files = walk(SRC);
    expect(files.length, "the walk found nothing — it would pass on an empty tree").toBeGreaterThan(100);
    const found: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(/export function (\w+)\(\s*(\w+)\s*:\s*string[^)]*\)\s*:\s*string/g)) {
        if (ID_PARAMS.test(m[2]!)) found.push(m[1]!);
      }
    }
    // `memberLabel` / `shortPrincipalId` are the wording itself; the other two are the surfaces that
    // reach it. Anything else here is a fifth way to name a person, and it has not been measured.
    expect(
      [...new Set(found)].sort(),
      "a function turns a subject id into a label. Add it to the assertions above, or it is a wording nothing checks",
    ).toEqual(["actorLabel", "authorLabel", "memberLabel", "revisionAuthorLabel", "shortPrincipalId"]);
  });
});
