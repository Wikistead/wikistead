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
    // the password branch shows passwordLinkLabel; the invite branch keeps inviteLinkLabel
    expect(src).toMatch(/lastLink\.kind === "invite"/);
    expect(src).toMatch(/passwordLinkLabel/);
    expect(src, "the setup link has its own testid").toMatch(/password-setup-link/);
  });

  it("neither locale's setup copy contains the word invite", () => {
    for (const { l, bundle } of locales) {
      const label = bundle.members.passwordLinkLabel as string;
      expect(label, `${l}: passwordLinkLabel exists`).toBeTruthy();
      expect(label.toLowerCase(), `${l}: not the invite's vocabulary`).not.toMatch(/invite|招待/);
    }
  });

  it("the refusal is readable in both locales, and stays UNIFORM", () => {
    for (const { l, bundle } of locales) {
      const msg = bundle.members.passwordSetupUnavailable as string;
      expect(msg, `${l}: the refusal has words`).toBeTruthy();
      // deliberately uniform: the copy must not name WHICH precondition failed (passwords off / already
      // has one / no address / identifier clash are indistinguishable by design)
      expect(msg.toLowerCase(), `${l}: no reason branch leaks into the copy`).not.toMatch(/already|既に|switch|無効|off\b/);
    }
    // and the handler maps the 400 to it rather than to the catch-all
    expect(src).toMatch(/passwordSetupUnavailable/);
    expect(src, "the password action does not fall through guarded's English catch-all")
      .toMatch(/if \(v === "password"\) \{[\s\S]{0,1200}?catch \(e\) \{[\s\S]{0,300}?passwordSetupUnavailable/);
  });
});
