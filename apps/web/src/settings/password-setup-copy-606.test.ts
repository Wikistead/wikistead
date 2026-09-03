// #606 (review rejection, 2026-08-04): the password-setup path speaks its own words.
//
// The mechanism landed correct end-to-end and the screen still said "invite": the success toast reused
// the invite-link label, and the refusal fell through a catch-all whose text was hard-coded English.
// Both resurrect the misreading this ticket exists to remove — an invite mints a person; this path adds
// an entrance to somebody already here.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(import.meta.dirname, "MembersPage.tsx"), "utf8");
const locales = ["en", "ja"].map((l) => ({
  l,
  bundle: JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8")),
}));

describe("#606: the password-setup path does not wear the invite's words", () => {
  it("the setup link renders under its own label, not the invite's", () => {
    // #646 renamed these: the two keys were labels printed above a value and became dialog titles, so
    // they lost their trailing colons and their bracketed guidance (which moved under the value). What
    // #606 asserts is unchanged — the password path wears its own words, not the invite's.
    // #638 moved the link into a modal, so the branch is on the dialog's title rather than inside a
    // paragraph. What #606 is about is unchanged and still asserted below: the two are told apart, and
    // the password one wears its own words.
    expect(src, "the two kinds are still told apart").toMatch(/lastLink\?\.kind === "password"/);
    expect(src).toMatch(/passwordLinkTitle/);
    expect(src, "the setup link has its own testid").toMatch(/password-setup-link/);
  });

  it("neither locale's setup copy contains the word invite", () => {
    for (const { l, bundle } of locales) {
      const label = bundle.members.passwordLinkTitle as string;
      expect(label, `${l}: passwordLinkLabel exists`).toBeTruthy();
      expect(label.toLowerCase(), `${l}: not the invite's vocabulary`).not.toMatch(/invite|招待/);
    }
  });

  it("the refusal is readable in both locales, and stays UNIFORM", () => {
    for (const { l, bundle } of locales) {
      const msg = bundle.members.passwordSetupUnavailable as string;
      expect(msg, `${l}: the refusal has words`).toBeTruthy();
      // Deliberately uniform, and the list is what #1074 amended. This code now covers the refusals
      // that are facts about the PERSON: they have no address of their own, or their address is
      // already somebody ELSE's sign-in name. Password sign-in being off for the tenant lands here
      // too for now (#1075 reconciles it with the local-invite door, which already names it).
      //
      // Two things are NOT on that list any more. "They already have a password" left it at #614
      // it is the reissue case, not a refusal. And "the deployment has no address" left it at #1074
      // that is a fact about the DEPLOYMENT, identical for every member, so naming it discloses
      // nothing about the one the admin picked, while hiding it turned an operator's settings mistake
      // into a mystery about a colleague. It has its own code and its own sentence now.
      expect(msg.toLowerCase(), `${l}: no reason branch leaks into the copy`).not.toMatch(/already|既に|switch|無効|off\b/);
    }
    // The handler maps the 400 to it rather than to the catch-all.
    //
    // This used to be one regex with two character budgets in it, and both of them went stale for
    // reasons that had nothing to do with what the pin claims: a comment grew past the first, and
    // #1074's branch pushed the sentence past the second. Widening the numbers would have made the
    // pin agree with the amendment without saying so — the one thing it must not do. So the branch
    // is cut out by its own boundaries and each claim is stated on its own.
    expect(src).toMatch(/passwordSetupUnavailable/);
    const branchStart = src.indexOf('if (v === "password")');
    expect(branchStart, "the password action is still a branch of the row menu").toBeGreaterThan(-1);
    const catchStart = src.indexOf("catch (e) {", branchStart);
    expect(catchStart, "the password action still has a catch of its own").toBeGreaterThan(-1);
    // Up to the next menu branch, so the window is the branch itself rather than a number.
    const nextBranch = src.indexOf('if (v === "', catchStart);
    const passwordCatch = src.slice(catchStart, nextBranch > -1 ? nextBranch : catchStart + 800);
    expect(passwordCatch, "…which names the deployment fact separately (#1074)")
      .toMatch(/deployment_has_no_address[\s\S]*?noAddressForLink/);
    expect(passwordCatch, "…and still answers every OTHER 400 with the one uniform sentence")
      .toMatch(/passwordSetupUnavailable/);
  });
});
