// #1175: a self-hosted install has nothing to bill, so it must not show a tab called "Billing", and
// the screen behind it must not claim "all features are included" — a CE build does not carry the
// EE-composed features at all (#723's lesson again: shipped copy naming a state the product is not in).
//
// Two things pin it. The tab reads the DEPLOYMENT fact (#864's `selfHosted`, the resolver registration
// the edition performs at composition time) and not a lever — every lever is UNLIMITED both on a
// self-host and on a top Cloud plan, so a lever could never tell the two apart. And every locale
// carries the usage label as a DIFFERENT word from the billing label; if a translation collapses the
// two, the rename is void in that language and nothing else would notice.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");
const page = read("settings/AdminPage.tsx");
const tab = read("settings/AdminBillingTab.tsx");
const LOCALES = resolve(SRC, "i18n/locales");
const bundle = (f: string) => JSON.parse(readFileSync(resolve(LOCALES, f), "utf8")) as {
  adminNav: Record<string, string>; billing: Record<string, string>;
};

describe("#1175 self-host shows usage, never billing", () => {
  it("the tab's name is decided by the deployment fact, and withheld until that fact is known", () => {
    expect(page).toContain("useEntitlements()");
    expect(page, "usage on a self-host, billing on the managed deployment").toMatch(
      /t\(selfHosted \? "adminNav\.usage" : "adminNav\.billing"\)/,
    );
    expect(page, "no tab at all while the answer is unknown — never a guessed name").toMatch(
      /selfHosted === undefined \? \[\]/,
    );
    expect(page, "the deployment fact, not a lever").not.toMatch(/\.branding\b[^\n]*adminNav\.(usage|billing)/);
  });

  it("the self-host screen is titled as the tab is", () => {
    const selfHostBranch = tab.slice(tab.indexOf("!status.data?.billingEnabled"));
    const firstPane = selfHostBranch.slice(0, selfHostBranch.indexOf("</SettingsPane>"));
    expect(firstPane).toContain('title={t("adminNav.usage")}');
    expect(firstPane, "the billing title must not survive on the self-host branch").not.toContain('t("billing.title")');
  });

  it("no locale claims all features are included on a self-host", () => {
    const files = readdirSync(LOCALES).filter((f) => f.endsWith(".json"));
    expect(files.length, "every registered locale is measured").toBeGreaterThanOrEqual(12);
    const claims: string[] = [];
    for (const f of files) {
      const b = bundle(f);
      const copy = b.billing.selfHosted;
      expect(copy, `${f}: billing.selfHosted exists`).toBeTruthy();
      // The English and Japanese sources; the other locales are translations of these two sentences
      // and are held by the label check below rather than by a phrase list nobody can vet.
      if (f === "en.json" && /all features/i.test(copy)) claims.push(f);
      if (f === "ja.json" && /すべての機能/.test(copy)) claims.push(f);
    }
    expect(claims, "these still say every feature is present").toEqual([]);
  });

  it("every locale names usage with a word that is not its word for billing", () => {
    const same: string[] = [];
    for (const f of readdirSync(LOCALES).filter((f) => f.endsWith(".json"))) {
      const nav = bundle(f).adminNav;
      expect(nav.usage, `${f}: adminNav.usage`).toBeTruthy();
      if (nav.usage === nav.billing) same.push(f);
    }
    expect(same, "a usage label equal to the billing label makes the rename void there").toEqual([]);
  });
});
