import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

// #617 ①: `MemberSearchInput` is declared to be "one implementation for every pick-a-member surface"
// (#416 / ADR-161). The SSO exemption screen had grown its own — candidates as up-to-5 buttons beside
// the field — which is how a shared component quietly becomes one of several.
//
// The pin WALKS the tree rather than listing the surfaces it knows about (#582 the shape): a NEW
// screen that hand-rolls a member picker is caught by existing, not by somebody remembering to add it
// here. Two questions are asked of every file: does it pick a member, and if so does it use the shared
// input.
const SRC = resolve(import.meta.dirname, "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = resolve(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

const FILES = walk(SRC).map((p) => ({ path: p, rel: p.slice(SRC.length + 1), src: readFileSync(p, "utf8") }));

describe("#617 ①: one member picker, measured by walking the tree", () => {
  it("finds a non-trivial number of components (a broken walk must not pass vacuously)", () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((f) => f.rel.endsWith("MemberSearchInput.tsx"))).toBe(true);
  });

  it("every surface that completes members uses the shared input", () => {
    // "completes members" = renders candidates from one of the member-candidate hooks. A file that only
    // READS members (a list, a roster) does not complete anything and is not a picker.
    const offenders: string[] = [];
    for (const f of FILES) {
      if (f.rel.endsWith("MemberSearchInput.tsx")) continue;
      const completes = /use(Tenant)?MemberCandidates\(/.test(f.src);
      if (!completes) continue;
      // it may render the shared component, or hand the candidates to something that does (a form)
      const shared = /<MemberSearchInput/.test(f.src) || /candidates=\{/.test(f.src);
      if (!shared) offenders.push(`${f.rel} — completes members without the shared input`);
    }
    expect(offenders).toEqual([]);
  });

  it("the SSO exemption screen is one of them (the surface this ticket came from)", () => {
    const f = FILES.find((x) => x.rel.endsWith("AdminSignInMethodsSection.tsx"))!;
    expect(f, "the file is where this test says it is").toBeTruthy();
    expect(f.src, "it uses the shared input").toMatch(/<MemberSearchInput/);
    // and the shape it replaced does not come back: candidates rendered as a row of buttons
    expect(f.src, "no hand-rolled candidate buttons").not.toMatch(/candidates\.[\s\S]{0,80}\.slice\(0, 5\)[\s\S]{0,120}<Button/);
  });

  it("the exemption row and its confirmation name the person, never the raw sub", () => {
    // #617 ②(a): both were rendering `x.memberSub` / interpolating `revokingExemption` directly.
    const f = FILES.find((x) => x.rel.endsWith("AdminSignInMethodsSection.tsx"))!;
    expect(f.src, "the row resolves a name").toMatch(/nameOf\(x\.memberSub\)/);
    expect(f.src, "the confirmation resolves a name").toMatch(/sub: nameOf\(revokingExemption\)/);
    expect(f.src, "the raw sub is not rendered as the row's label").not.toMatch(/flex-1 truncate">\{x\.memberSub\}/);
  });
});
