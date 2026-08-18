// #732: one thing, one name — in the strings the product actually shows.
//
// The product called the same object a "tenant" in 24 Japanese strings and a "workspace" in 39,
// including the admin console's own heading / "Tenant admin"). The docs had been made
// consistent on — on the stated grounds that "tenant is an internal word; the UI says
// " — so the rule the documentation was keeping was one the UI did not keep. #718 then
// rewrote 45 Japanese pages to that vocabulary, which left the two surfaces disagreeing about the
// name of the central object a reader meets on day one.
//
// The owner's ruling: workspace wins. Identifiers keep their names — an audit action is
// `tenant_settings` in the ledger forever, because renaming it would break the join between old rows
// and new ones — so only DISPLAY strings move. Internal code (`tenantId`, `TenantDb`) is out of scope
// by the same reasoning.
//
// Discovery, not a list: the check walks the locale files, so a NEW string carrying the retired word
// fails on the commit that adds it rather than at the next audit. That is the shape #585 established
// after three hand-written copy pins went stale in a week.
import { describe, it, expect } from "vitest";
import en from "./locales/en.json";
import ja from "./locales/ja.json";

type Tree = { [k: string]: string | Tree };

const flatten = (tree: Tree, prefix = ""): [string, string][] =>
  Object.entries(tree).flatMap(([k, v]) =>
    typeof v === "string" ? [[prefix + k, v] as [string, string]] : flatten(v, `${prefix}${k}.`),
  );

/**
 * The retired words, per locale, and what replaced them.
 *
 * `Claim` and are here for the same reason as the tenant/workspace pair rather than as a
 * separate concern: they are single words in one screen that no other screen uses — the orphan-drafts
 * tab said "Claim " with an English verb standing alone in Japanese copy, and the embeds tab
 * said , a literal rendering of "degrade" that #718 had just removed from the
 * documentation. One sweep, one pin, because they fail the same way: a reader meets a word the rest
 * of the product never uses.
 */
const RETIRED: Record<"en" | "ja", { word: RegExp; use: string; why: string }[]> = {
  ja: [
    { word: /テナント/, use: "ワークスペース", why: " one name for the object" },
    { word: /ドラフト/, use: "下書き", why: "the rest of the product says 下書き" },
    { word: /\bClaim\b/, use: "引き取る", why: "a lone English verb in Japanese copy" },
    { word: /降格/, use: "リンクになる など", why: "literal rendering of 'degrade' (#718)" },
  ],
  en: [{ word: /\btenants?\b/i, use: "workspace", why: " one name for the object" }],
};

/**
 * Strings that keep a retired word, each with the reason it is not the same mistake.
 *
 * Every entry is a full key. A prefix rule would quietly cover keys added later, which is how an
 * exception list becomes a second vocabulary.
 */
const ALLOWED: Record<string, string> = {
  // Microsoft's own term for the directory id. Renaming it would send administrators looking for a
  // field their IdP does not have.
  "adminConnections.entraPlaceholder": "Entra's own term for the directory",
  // #740 gave that field a visible label, and the label carries the same borrowed noun for the
  // same reason: an administrator copies this value out of a Microsoft screen that calls it a
  // tenant, and renaming it here would leave them hunting for something Entra does not have.
  "adminConnections.entraTenantId": "Entra's own term for the directory",
};

describe("#732: the product uses one name for a workspace", () => {
  for (const [locale, tree] of [["en", en], ["ja", ja]] as const) {
    it(`${locale}: no user-visible string carries a retired word`, () => {
      const offenders = flatten(tree as Tree)
        .filter(([key]) => !(key in ALLOWED))
        .flatMap(([key, value]) =>
          RETIRED[locale]
            .filter((r) => r.word.test(value))
            .map((r) => `${key} = ${value}  → use ${r.use} (${r.why})`),
        );
      expect(offenders, "one thing, one name (#671 / #732)").toEqual([]);
    });
  }

  // The exceptions have to stay attached to something real. A key that no longer exists means the
  // exception is being carried for a string nobody ships — and the next person reads the list as
  // "these are still needed".
  it("every declared exception still names a live string", () => {
    const keys = new Set([...flatten(en as Tree), ...flatten(ja as Tree)].map(([k]) => k));
    expect(Object.keys(ALLOWED).filter((k) => !keys.has(k))).toEqual([]);
  });

  // …and the matcher has to be able to fail. If the retired words stopped matching anything at all
  // a rename of the locale shape, a regex that no longer compiles the way it reads — this file would
  // pass while checking nothing, which is the failure mode it exists to prevent.
  it("the matcher still recognises the words it retired", () => {
    const sample = { a: "このテナントの設定", b: "孤立ドラフト", c: "Claim すると", d: "リンクに降格します" };
    const hits = flatten(sample).filter(([, v]) => RETIRED.ja.some((r) => r.word.test(v)));
    expect(hits.map(([k]) => k)).toEqual(["a", "b", "c", "d"]);
    expect(RETIRED.en[0]!.word.test("Whole tenant")).toBe(true);
    expect(RETIRED.en[0]!.word.test("Whole workspace")).toBe(false);
  });
});
