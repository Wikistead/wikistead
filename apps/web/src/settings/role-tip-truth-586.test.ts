// #586 review: what a role surface SAYS a role does must be what the model gives it.
//
// The defect this closes is not a missing feature — it is a confident falsehood. A page grant row looked
// its badge up in the table of built-in NOUNS, so a page `edit` grant was described as being able to
// comment. The server pins the opposite (`a bare edit grant is NOT the editor noun`), which means the
// product asserted one thing and enforced another, on the very screen built to end the guessing.
//
// Both closure tables are measured against a real OpenFGA store by
// `apps/server/src/__tests__/role-capability-truth-586.test.ts`. These pins are about the CLIENT: that
// it reads the right one, that one closure serves every surface, and that a surface offering a role
// says what the role does before it is chosen.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { BUILTIN_EFFECTIVE_CAPS, PAGE_GRANT_CAPS, CAP_NOUN, TENANT_TIER_CAPS, tenantTierCaps, closureOf, effectiveCaps, builtinDisplayCaps, nounCapability } from "./role-nouns";
import { roleOptions } from "./tenant-role-rows";
import { withRoleTips } from "./role-option-tips";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";

const web = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(web, p), "utf8");

/** Every .ts/.tsx in the app, so a pin about "all surfaces" is about all of them. */
function appFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = resolve(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(p);
    }
  };
  walk(web);
  return out;
}

describe("#586 review ①: a page grant says what a page grant confers", () => {
  it("the two tables are different, and the edit row is where", () => {
    // If they ever became equal, one would look redundant and someone would delete the wrong one.
    expect(BUILTIN_EFFECTIVE_CAPS.edit, "the editor NOUN is a composite that includes comment").toContain("comment");
    expect(PAGE_GRANT_CAPS.edit, "a page edit grant is one arm — #553 severed edit ⇒ comment").not.toContain("comment");
    // and the surprise the measurement turned up: a page manage grant does not reach the moderator leaf
    expect(BUILTIN_EFFECTIVE_CAPS.manage).toContain("moderate");
    expect(PAGE_GRANT_CAPS.manage, "a page manage grant does not reach `space#moderator = … or manager`").not.toContain("moderate");
  });

  it("the page dialog asks for the page table", () => {
    const dialog = read("ui/PermissionsDialog.tsx");
    for (const m of dialog.matchAll(/<RoleTip[^>]*>/g)) {
      expect(m[0], "every RoleTip on the page dialog is page-scoped").toContain('scope="page"');
    }
    expect([...dialog.matchAll(/<RoleTip[^>]*>/g)].length, "the dialog still has role tips at all").toBeGreaterThan(0);
  });

  it("the pairing with the server pin: the same case it measures false, the client must not claim", () => {
    // The server grants a bare `edit` and measures comment=false. This is the client side of that fact.
    expect(effectiveCaps({ builtinCapability: "edit", scope: "page" })).not.toContain("comment");
    expect(effectiveCaps({ builtinCapability: "edit" }), "the space noun is a different thing").toContain("comment");
  });
});

describe("#586 review ②: one closure, so one answer", () => {
  it("a custom role reads the same in a tooltip as in the role editor", () => {
    // A `moderate`-only role: one line in the tooltip, five ticked boxes in the editor. Same role.
    const viaTooltip = effectiveCaps({ roleCapabilities: ["moderate"] });
    expect(viaTooltip).toEqual(closureOf(["moderate"]));
    expect(viaTooltip, "the closure, not the declaration").toContain("comment");
  });

  it("the role editor computes subsumption through that same function", () => {
    const tab = read("settings/AdminRolesTab.tsx");
    expect(tab, "no second table here — the gap between two is where #485 and #536 lived").toContain("closureOf(");
    expect(tab).not.toMatch(/BUILTIN_EFFECTIVE_CAPS\s*\[/);
  });

  it("scope selects the table for custom roles too", () => {
    expect(effectiveCaps({ roleCapabilities: ["edit"], scope: "page" })).not.toContain("comment");
    expect(effectiveCaps({ roleCapabilities: ["edit"] })).toContain("comment");
  });
});

describe("#586a surface that offers a role says what the role does", () => {
  it("a role option is a NAME, and what it confers is revealed — found by walking, not by a list", () => {
    // REVERSED by the 2026-08-03 ruling. The previous shape demanded a `hint:` on every role option, and
    // the implementation obliged by printing the capabilities under all nine labels: the reader had to
    // read the whole vocabulary to pick one name. — so the
    // option carries the name, and `RoleTip` carries the meaning.
    //
    // WIDENED after a miss: the walk used to key on `capNoun(`, so a picker offering ONLY custom roles
    // (`label: r.name`) was invisible to it, and one shipped without any way to ask what its roles do.
    // A role option is now recognised by the SHAPE OF ITS LABEL — a capability noun or a role's own
    // `.name` — which is independent of how the list happens to be built.
    const offenders: string[] = [];
    let pickers = 0;
    for (const f of appFiles()) {
      const src = readFileSync(f, "utf8");
      // Builder modules that only assemble options are checked where the Select actually is: they hand
      // back `RoleChoice[]` and the screen decides. A file with no Select renders nothing to hover.
      if (!/<Select|roleOptions=/.test(src)) continue;
      for (const m of src.matchAll(/label:\s*(capNoun\(|[A-Za-z_$][\w$]*\.name\b)/g)) {
        pickers++;
        const before = src.slice(Math.max(0, m.index! - 220), m.index!);
        const after = src.slice(m.index!, m.index! + 300);
        const where = `${f.slice(web.length + 1)}: ${after.replace(/\s+/g, " ").slice(0, 90)}`;
        // RE-AIMED by #582 (review rejection, 2026-08-04). For one round the reveal was drawn INSIDE the
        // option, and the ruling rejected that too: "…" — a floating
        // panel, the one the row badges already raise. So both idioms now hand the Select a PANEL
        // through `withRoleTips`, or as an inline `hint: <RoleCaps …>`. What must not come back is a
        // wrapper that renders capability text into the row.
        if (/wrap:/.test(after)) { offenders.push(`${where} — draws the capabilities inside the option`); continue; }
        const revealed = /withRoleTips\(/.test(before) || /hint:[\s\S]{0,120}RoleCaps/.test(after);
        if (!revealed) offenders.push(`${where} — a role name with no way to ask what it does`);
      }
    }
    expect(pickers, "the walk actually found role pickers").toBeGreaterThanOrEqual(4);
    expect(offenders, "a role option is its name, and hovering it says what that name confers").toEqual([]);
  });

  it("#579 (2026-08-04): EVERY option the tenant vocabulary offers can be asked what it confers", () => {
    // The lexical walk above recognises a role option by its label shape (`capNoun(…)` or `x.name`), and
    // a TIER's label is neither — it is the bare tier string. So the tiers slipped through it and shipped
    // silent: hovering `bbb` explained itself, hovering `admin` said nothing. "
    //
    // Run the real builder instead of reading the file: given what the SCREEN has (the tenant's live
    // tier defaults — #582 ① takes `member` from those rather than from a constant, because that
    // capability rides a per-tenant switch), every entry it offers must carry a capability source. A
    // tier added later, or a third mechanism, is covered without touching this test — and nothing here
    // names `member` or `admin`.
    const custom = [
      { id: "r1", name: "bbb", scope: "tenant", capabilities: ["issueApiKeys"] },
      { id: "r2", name: "space-only", scope: "resource", capabilities: ["view"] },
    ];
    const options = roleOptions(custom, tenantTierCaps({ createSpaces: true, issueApiKeys: false }));
    expect(options.length, "the builder offered a vocabulary to check").toBeGreaterThan(2);
    // presence of the SOURCE, not of entries in it: a tenant that switched every member capability off
    // leaves an honest empty list, and a panel that says so is not the defect (silence was).
    const bare = options.filter((o) => o.roleCapabilities === undefined).map((o) => o.label);
    expect(bare, "a role name with no way to ask what it does").toEqual([]);
    // …and the wrapper turns each of them into the SAME floating panel the badges raise
    const withoutHint = withRoleTips(options, "tenant").filter((o) => !o.hint).map((o) => o.label);
    expect(withoutHint, "every offered name reveals through one component").toEqual([]);
    // the admin row is the MEASURED table, not a copy: change the table and the option follows
    const adminOption = options.find((o) => o.label === "admin")!;
    expect(adminOption.roleCapabilities).toEqual(TENANT_TIER_CAPS.admin);
  });

  it("nothing anywhere prints a capability list under an option", () => {
    // The reject was about the SHAPE, not about one screen: capability text living in the row. Two shapes
    // have now been rejected for it — a printed line, then an in-row reveal — so what is banned is text
    // rendered INTO the option, whichever prop carries it.
    const offenders = appFiles()
      .filter((f) => /hint:\s*(effectiveCaps|closureOf|\[)|wrap:[\s\S]{0,120}(RoleTip|capNoun)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(web.length + 1));
    expect(offenders, "capabilities are shown in a floating panel, not inside the choice").toEqual([]);
  });

  it("the Select raises a floating panel, and has no way to draw one inside the row", () => {
    // Belt and braces: as long as a prop that renders into the item exists, a screen can reach for it
    // again and the walk above only catches the callers it can recognise.
    const select = read("ui/Select.tsx");
    expect(select, "the in-row wrapper went with the shape it drew").not.toMatch(/wrap\?:/);
    expect(select, "and the panel slot is there").toMatch(/hint\?:/);
    expect(select, "raised above the select's own layer, outside the box that clips it").toContain("createPortal");
    // the highlight is what a keyboard user moves; a focus-based reveal never opens for them
    expect(select).toContain("data-highlighted");
  });

  it("the capability vocabulary is complete, so nothing falls through as a raw wire value", () => {
    // `manage` used to be missing, so a tooltip read "… Share manage" with one word out of case: the
    // fallback is the wire value, and a missing key is invisible until it is on screen.
    const named = new Set<string>();
    for (const t of [BUILTIN_EFFECTIVE_CAPS, PAGE_GRANT_CAPS]) for (const caps of Object.values(t)) for (const c of caps) named.add(c);
    for (const loc of [en, ja] as unknown as Array<{ adminRoles: { cap: Record<string, string> } }>) {
      for (const c of named) expect(loc.adminRoles.cap[c], `adminRoles.cap.${c}`).toBeTruthy();
    }
  });
});

describe("#586 review ①(bounce 3): the roles list ticks what the store confers", () => {
  // The screen that EXISTS to say what a role can do was showing `manager` with Moderate unticked
  // the exact error ADR-203 §4 named when this ticket was opened, still on screen three rounds later.
  // Its source was the server's declared bundle (`BUILT_IN_ROLES`), which omits `manage`, so the UI's
  // closure had no starting point to reach `moderate` from.
  //
  // No hand-written expectation here: that would copy the mistake into the test. The comparison is
  // against the MEASURED table, which `role-capability-truth-586.test.ts` keeps equal to a real
  // OpenFGA store.
  const tab = read("settings/AdminRolesTab.tsx");
  const columns = [...(/const CAPABILITIES = \[([^\]]*)\]/.exec(tab)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]!);

  it("the grid's columns were found (a pin over an empty set proves nothing)", () => {
    expect(columns.length).toBeGreaterThan(5);
  });

  it("every built-in role's ticks are the measured closure, filtered to the grid's columns", () => {
    for (const [cap, noun] of Object.entries(CAP_NOUN)) {
      const expected = BUILTIN_EFFECTIVE_CAPS[cap as keyof typeof BUILTIN_EFFECTIVE_CAPS].filter((c) => columns.includes(c));
      expect(builtinDisplayCaps(noun, columns), `${noun}`).toEqual(expected);
    }
    // …and the case that was wrong on screen, named so a regression reads as itself
    expect(builtinDisplayCaps("manager", columns), "a manager moderates — the store says so").toContain("moderate");
  });

  it("the list renders the MEASURED answer, not the server's declared bundle", () => {
    // RE-AIMED by #586②: the read-only grid left the list ("
    // "), so what carries the measured answer now is the name's hover window. The built-in rows hand
    // RoleTip the measured sources — the noun for a space built-in, the measured tier table for admin
    // and never the server's declared bundle.
    const builtinRow = tab.slice(tab.indexOf("roles.data?.builtIn"), tab.indexOf("roles.data?.builtIn") + 900);
    expect(builtinRow, "a space built-in explains itself through the measured closure").toMatch(/RoleTip[\s\S]{0,120}builtinCapability=\{nounCapability\(r\.name\)\}/);
    expect(builtinRow, "…and not the declared bundle").not.toMatch(/value=\{r\.capabilities\}/);
    const adminRow = tab.slice(tab.indexOf('data-testid="builtin-role-admin"'), tab.indexOf('data-testid="builtin-role-admin"') + 900);
    expect(adminRow, "the admin tier reads the measured tier table (#604's verbs arrive with it)").toContain("TENANT_TIER_CAPS.admin");
    expect(adminRow, "the hand-written two-capability value is gone").not.toContain('value={["createSpaces", "issueApiKeys"]}');
  });

  it("a name the nouns do not know ticks nothing rather than guessing", () => {
    expect(nounCapability("kakunin-582")).toBeUndefined();
    expect(builtinDisplayCaps("kakunin-582", columns)).toEqual([]);
  });
});

describe("#586 review ④: the hygiene pins reach every role surface", () => {
  it("no role surface hardcodes a colour — DS tokens only", () => {
    // Was checked on PermissionsDialog alone, which is one of at least three files that draw these rows.
    const offenders: string[] = [];
    for (const f of appFiles()) {
      const src = readFileSync(f, "utf8");
      if (!/RoleTip|capNoun\(/.test(src)) continue;
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
      for (const m of code.matchAll(/#[0-9a-fA-F]{6}\b/g)) offenders.push(`${f.slice(web.length + 1)}: ${m[0]}`);
    }
    expect(offenders, "colour belongs to the design tokens (user ruling: no hardcoding)").toEqual([]);
  });

  it("the tooltip opens on a tap, not only on hover and focus", () => {
    // A coarse pointer has no hover at all (ADR-159), so a hover-only explanation is no explanation on a
    // tablet. Radix closes an uncontrolled trigger on pointerdown, which turns the tap that should open
    // it into the tap that hides it — hence the controlled `open`.
    const tip = read("ui/RoleTip.tsx");
    expect(tip, "controlled, or the tap toggles it shut").toContain("open={open}");
    expect(tip).toContain("onClick");
  });
});
