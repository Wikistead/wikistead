// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { derivedScope, newKeyDefaultExpiry, RESOURCE_TYPE_OPTIONS } from "./api-key-permissions";
import { expiryChoices } from "./key-expiry-choices";

// #667 / ADR-221 §5 §10: what the form decides on the reader's behalf, and what it must not.
//
// The ruling that opened #667 named two problems in one screen: the permissions were too coarse to say
// anything useful, and the form asked two questions ("read/write" AND "what it may do") where every
// comparable product asks one. The second is what these cases are about — the derivation has to be right
// AND the second control has to actually go away, or the duplication the ruling objected to is still on
// screen with an extra step.

describe("#667 §5: the scope is derived from the matrix", () => {
  it("every cell read gives a read key; one write cell gives a write key", () => {
    expect(derivedScope({}), "an empty matrix asks for nothing, so it asks for read").toBe("read");
    expect(derivedScope({ pages: "read", search: "read" })).toBe("read");
    expect(derivedScope({ pages: "read", comments: "write" }), "one write cell is enough").toBe("write");
    expect(derivedScope({ pages: "write" })).toBe("write");
  });

  it("the scope control is not rendered while a matrix is picked", () => {
    // The ruling's actual words were about the duplication being visible. A derivation that left the
    // Select on screen showing a value nobody chose would satisfy the letter and not the complaint.
    // NOT comment-stripped: the JSX comment above the control is `{/* … */}`, and a strip that eats the
    // braces around it takes the conditional's opening brace with it. Measured — the assertion failed
    // against a file the strip had rewritten, not against the product.
    const panel = readFileSync(resolve(import.meta.dirname, "ApiKeysPanel.tsx"), "utf8");
    expect(panel, "the scope Select is behind the matrix being empty")
      .toMatch(/\{!matrixPicked && \([\s\S]{0,200}?testId="api-key-scope"/);
  });

  it("…and it comes back when there is no matrix, which is the CE case", () => {
    // Without the EE overlay there is no matrix at all, and requirement 2 ruled that read/write stays
    // the only choice there. A form that hid the Select unconditionally would leave that deployment with
    // no way to ask for a read-only key.
    const panel = readFileSync(resolve(import.meta.dirname, "ApiKeysPanel.tsx"), "utf8");
    expect(panel, "the condition is on the matrix, not on the overlay").toContain("!matrixPicked &&");
    expect(panel, "and the options are still built").toContain("scopeOptions");
  });
});

// #667 (ruling, 2026-08-09): the per-type default was REVERSED. The ruling: the inconsistency is
// off-putting, just default everything to 30 days — and it was not only untidy: an ordinary key
// defaulted to never
// expiring, so the most dangerous option was pre-selected on the majority of keys.
//
// The cases below are the ones that SURVIVE the reversal (thirty is picked; a tighter ceiling is
// respected; it is a default and not a cap). What is gone is the conditional — and the case that used
// to enumerate the three administrative names, because there is no longer a question to answer about
// which types those are, which is half of what the ruling bought.
describe("#667 (ruling): one default lifetime, whatever is selected", () => {
  it("does not depend on what is selected", () => {
    // The reversal itself, measured on the code rather than on the helper: the form must not branch on
    // the matrix when choosing a default. Written as the absence of the old branch AND of a reader for
    // the flag, because either one surviving brings the inconsistency back.
    const panel = readFileSync(resolve(import.meta.dirname, "ApiKeysPanel.tsx"), "utf8");
    expect(panel, "the default still branches on the selection").not.toContain("adminPicked");
    expect(panel, "the shortened-lifetime note is still shown").not.toContain("adminExpiryNote");
    const perms = readFileSync(resolve(import.meta.dirname, "api-key-permissions.ts"), "utf8");
    expect(perms, "the types still carry an administrative flag").not.toMatch(/\badmin\??:/);
  });

  it("is thirty days, not never, when the tenant has no ceiling", () => {
    // THE point of the ruling. A pin that only asked "the same whatever is selected" would be satisfied
    // by defaulting everything to never — which is where the majority of keys already were.
    const choices = expiryChoices(null);
    expect(choices.some((c) => c.days === 30), "the ladder has a thirty-day rung").toBe(true);
    expect(choices.some((c) => c.days === null), "…and never is on it too, as the contrast").toBe(true);
    const picked = newKeyDefaultExpiry(choices);
    expect(picked, "an unlimited tenant defaults to never expiring again").not.toBe("");
    expect(picked).toBe("30");
  });

  it("…and stays inside a tighter tenant ceiling rather than naming one that does not exist", () => {
    // A Select whose value matches no option renders as a bare chevron with no width (#603), so
    // asking for thirty on a seven-day policy would be a visual defect as well as a wrong default.
    const tight = expiryChoices(7);
    const picked = newKeyDefaultExpiry(tight);
    expect(tight.some((c) => c.value === picked), "the default exists in the list").toBe(true);
    expect(Number(picked)).toBeLessThanOrEqual(7);
  });

  it("and it is a DEFAULT, not a cap — never stays selectable", () => {
    // §10 is explicit: the ceiling belongs to the tenant (#628), and a second one visible only to some
    // type combinations would make the form refuse what the API grants. So the "never" option must still
    // be offered on a tenant with no ceiling, whatever types are picked.
    const choices = expiryChoices(null);
    expect(choices.some((c) => c.days === null), "an unlimited tenant still offers never").toBe(true);
    const panel = readFileSync(resolve(import.meta.dirname, "ApiKeysPanel.tsx"), "utf8");
    expect(panel, "the options are not filtered by what was picked").not.toMatch(/expiryOptions[\s\S]{0,200}adminPicked/);
  });

  it("stops moving once the reader chooses for themselves", () => {
    const panel = readFileSync(resolve(import.meta.dirname, "ApiKeysPanel.tsx"), "utf8");
    expect(panel, "an explicit choice is remembered").toContain("setExpiryTouched(true)");
    expect(panel, "and the default stops following it").toMatch(/if \(expiryTouched\) return;/);
  });
});

describe("#667 §3: keys issued under the old model are marked, never remapped", () => {
  it("the panel marks a v1 key and offers no automatic upgrade", () => {
    const panel = readFileSync(resolve(import.meta.dirname, "ApiKeysPanel.tsx"), "utf8");
    expect(panel, "the mark exists").toContain('data-testid="api-key-legacy-model"');
    expect(panel, "…on the model, not on the absence of a matrix").toMatch(/k\.permissionModel === 1/);
    // Silently upgrading a credential somebody handed to an outside service is what §3 exists to
    // prevent, so nothing in the panel may rewrite a key's permissions in place.
    expect(panel, "no in-place upgrade").not.toMatch(/upgradeKey|convertKey|migrateKey/);
  });

  it("an UNNARROWED key carries no mark at all", () => {
    // Most keys are unconfined; marking them would make the exception look ordinary, which is the same
    // reasoning #658 used for the confinement badge.
    const panel = readFileSync(resolve(import.meta.dirname, "ApiKeysPanel.tsx"), "utf8");
    expect(panel, "the mark needs a confinement as well as the model")
      .toMatch(/k\.permissionModel === 1 && \(k\.capabilities \|\| k\.spaces\)/);
  });
});

describe("#667: the picker offers nothing the server would refuse", () => {
  it("no read-only type is offered as writable", () => {
    for (const id of ["search", "activity", "audit"]) {
      const o = RESOURCE_TYPE_OPTIONS.find((x) => x.id === id);
      expect(o, `${id} is offered at all`).toBeDefined();
      expect(o!.writable, `${id} has no write route — the server answers unreachable_permission`).toBe(false);
    }
  });

});
