// #745 / ADR-240: the door offers a choice of proof, and offers exactly what it offered before.
//
// The chooser is a new RENDERING of a set that already crossed the wire. So the property worth
// holding is not "a chooser appears" — it is that the SET is unchanged, that a refusal does not
// shrink it, and that nobody is charged a click for a decision with one answer. Those three are what
// a future edit could quietly break while every screenshot still looks right.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { doorProofs, doorInitialProof } from "./FactorStep";

const STEP = readFileSync(resolve(import.meta.dirname, "FactorStep.tsx"), "utf8");

describe("#745: the door offers exactly the proofs the server sent", () => {
  it("passes the server's kinds through, in the ruled order", () => {
    // Owner rulingauthenticator app first, passkey second — fixed, not "the one you used last".
    expect(doorProofs(["passkey", "totp"], true)).toEqual(["totp", "passkey"]);
    expect(doorProofs(["totp"], true)).toEqual(["totp"]);
    expect(doorProofs(["passkey"], true)).toEqual(["passkey"]);
  });

  it("adds nothing the server did not send", () => {
    // The set is the disclosure. If this ever grows an entry, the door has started answering a
    // question nobody asked it — which is the thing #687 settled and this ticket must not reopen.
    expect(doorProofs(["totp"], true)).not.toContain("passkey");
    expect(doorProofs(["passkey"], true)).not.toContain("totp");
  });

  it("drops a passkey this BROWSER cannot perform — a fact about the window, not the account", () => {
    expect(doorProofs(["totp", "passkey"], false)).toEqual(["totp"]);
    expect(doorProofs(["passkey"], false)).toEqual([]);
  });

  it("reads an absent list as both, which is what the screen offered before #678 existed", () => {
    expect(doorProofs(undefined, true)).toEqual(["totp", "passkey"]);
    expect(doorProofs([], true)).toEqual(["totp", "passkey"]);
  });

  it("skips the chooser for a lone proof, and shows it for a fork", () => {
    // Measured on the other screen (#650): this is the half a rendering assertion cannot see — the
    // form is handed a method and draws it, so a regression that stopped skipping stays green there.
    expect(doorInitialProof(["totp"])).toBe("totp");
    expect(doorInitialProof(["passkey"])).toBe("passkey");
    expect(doorInitialProof(["totp", "passkey"])).toBeNull();
  });

  it("has no start at all when there is nothing to offer (the lock-out, #672 ③)", () => {
    // The screen must draw its "this browser cannot" sentence here. An empty chooser is the empty
    // panel that ruling accepted the lock-out on condition of avoiding.
    expect(doorProofs(["passkey"], false)).toHaveLength(0);
    expect(doorInitialProof([])).toBeNull();
  });

  it("draws the lock-out sentence for the empty case, rather than an empty chooser", () => {
    // ⚠️ Written twice. The first version asserted that the file CONTAINS the message's testid, and a
    // break-check renamed the testid — every assertion stayed green, because a renamed marker is still
    // a marker. What matters is that the empty branch RENDERS SOMETHING, so this reads the branch and
    // requires a message element inside it. ADR-240 named this the case a chooser is most likely to
    // erase: "no entries" and "an empty list" look identical to the code that draws them.
    const empty = STEP.slice(STEP.indexOf("proofs.length === 0 ? ("), STEP.indexOf(") : picked === null ? ("));
    expect(empty.length, "the empty case is not a branch of its own at all").toBeGreaterThan(40);
    expect(empty, "the empty branch renders no message — the member meets a blank panel (#672 ③)")
      .toMatch(/<p[^>]*data-testid=/);
    expect(empty, "the empty branch shows no sentence from the copy catalogue").toMatch(/\{t\("auth\./);
  });

  it("keeps the chooser intact on a refusal — offering must not become probing", () => {
    // #650: four causes, one sentence. A chooser that drops the kind that just failed would report
    // which one it was, by omission.
    //
    // ⚠️ Also written twice. The first version forbade one SPELLING of the filter, and a break-check
    // that wrote a different one passed. The honest property is that the offered set depends on the
    // server's kinds and the browser — and on nothing else — so this reads the assignment and requires
    // its right-hand side to be exactly the derivation, with nothing appended.
    const line = STEP.split("\n").find((l) => l.includes("const proofs = doorProofs("));
    expect(line, "the offered set is no longer derived in one place").toBeTruthy();
    expect(line!.trim(), "something narrows the offered set after it is derived — a refusal must not shrink it")
      .toBe("const proofs = doorProofs(kinds, webauthn);");
    expect(STEP, "the failure banner names a kind — the door answers four causes with one sentence")
      .not.toMatch(/failed === "(totp|passkey)"/);
  });
});
