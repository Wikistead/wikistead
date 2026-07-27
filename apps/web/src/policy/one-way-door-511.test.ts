// #511/ the make-private direction of the bulk visibility verb is a ONE-WAY DOOR, and the
// ruling was that it must be confirmed before it runs while clearing private stays a direct click.
//
// Nothing structural held that. The #510 guard only knows the delete-class vocabulary (delete / remove /
// revoke / …), and "privatise" is not lexically destructive — it destroys no content, it removes REACH,
// including the actor's own: `share_from_space: sharer from space but not private` means the moment a
// space manager privatises a page they do not personally hold, they lose `share` on it and only that
// page's direct holder can undo it. Measured, not theorised (bulk-visibility-511.test.ts pins the
// server side of the same fact).
//
// So this pins the UI side directly, reusing the #510 analyzer's confirm-context machinery: the
// privatising call must sit inside a confirm context, and the clearing call must NOT — a confirm on the
// reversible direction would be the cost without the benefit, and the ruling says so explicitly.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { confirmContextRanges } from "./destructive-guard";

const FILE = resolve(import.meta.dirname, "../settings/SpacePagesTab.tsx");

// Offsets of every `runBulkVisibility(<arg>)` call with the given argument.
function callOffsets(src: string, arg: "true" | "false"): number[] {
  const out: number[] = [];
  const re = new RegExp(String.raw`runBulkVisibility\(\s*${arg}\s*\)`, "g");
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m.index);
  return out;
}

const inside = (ranges: { from: number; to: number }[], at: number) =>
  ranges.some((r) => at >= r.from && at <= r.to);

describe("#511 bulk visibility — the make-private direction stays behind a confirm", () => {
  it("privatising runs only from a confirm context; clearing private runs directly", () => {
    const src = readFileSync(FILE, "utf8");
    const ranges = confirmContextRanges(src);
    const privatising = callOffsets(src, "true");
    const clearing = callOffsets(src, "false");

    // Non-vacuity first: if the calls were renamed away this test would otherwise pass on an empty set
    // and silently stop guarding anything.
    expect(privatising.length, "the make-private call still exists (rename? update this pin)").toBeGreaterThan(0);
    expect(clearing.length, "the clear-private call still exists").toBeGreaterThan(0);

    for (const at of privatising) {
      expect(inside(ranges, at), "make-private must be executed BY a confirm, not by the button").toBe(true);
    }
    for (const at of clearing) {
      expect(inside(ranges, at), "clearing private hands access back — the ruling keeps it a direct click").toBe(false);
    }
  });

  it("the confirm names the consequence rather than just asking", () => {
    // A generic "are you sure" would satisfy the structural check above while telling the person nothing
    // about what they are giving up, which is the entire reason this confirm exists.
    const src = readFileSync(FILE, "utf8");
    expect(src, "the confirm uses the dedicated one-way-door copy").toContain("spacePages.bulkPrivateConfirm");
    const en = JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales/en.json"), "utf8"));
    const copy: string = en.spacePages.bulkPrivateConfirm;
    expect(copy, "it says the caller loses access").toMatch(/lose access/i);
    expect(copy, "and that they cannot undo it themselves").toMatch(/not be able to undo/i);
  });
});
