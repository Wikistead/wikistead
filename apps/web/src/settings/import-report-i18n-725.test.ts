// @vitest-environment happy-dom
// #725(review rejection) — the three things a reader could not do on this screen.
//
// ② was the serious one: in a Japanese UI, every degrade reason came out in English. The headings and the page's own
// prose translated; `degraded[]` did not, because the server wrote those sentences in English and the
// screen printed them through. This is the report — the feature's whole point is that a person can
// read it and decide what to redo by hand — so English in the middle of it is the defect, not a
// rough edge.
//
// Measured against the REAL locale bundles and the RENDERED text, so "it is translated" means the
// words a person would see. The other 725 pins mock `t` to return the key (deliberately: they are
// about naming, and a key cannot accidentally match prose). That mock cannot answer this question,
// which is why this is a second file rather than more cases in the first.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ImportReport } from "../data/exportApi";

const bundles = Object.fromEntries(["en", "ja"].map((l) =>
  [l, JSON.parse(readFileSync(resolve(import.meta.dirname, "../i18n/locales", `${l}.json`), "utf8"))]));

let lang = "ja";
/** the real lookup, including i18next's `defaultValue` and `{{var}}` interpolation */
const translate = (key: string, opts?: Record<string, unknown>) => {
  const hit = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles[lang]);
  const raw = typeof hit === "string" ? hit : (opts?.defaultValue as string | undefined) ?? key;
  return raw.replace(/\{\{(\w+)\}\}/g, (m, v: string) => (opts && v in opts ? String(opts[v]) : m));
};

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate, i18n: { language: lang } }) }));
vi.mock("react-router-dom", () => ({
  Link: ({ children, ...rest }: { children?: unknown }) => createElement("a", rest as never, children as never),
}));

const { ImportReportView } = await import("./SpaceImportTab");

/** the report the reviewer actually saw on screen, in the shape the server now sends */
const REPORT: ImportReport = {
  degraded: [
    {
      node: "Weekly Review", code: "dataviewKeptAsSource", params: { count: 1 },
      what: "Dataview query kept as source",
      detail: "1 block(s) — the query text is preserved and renders as a code block",
    },
    {
      node: "Weekly Review", code: "headingAnchorDropped", params: { target: "Roadmap", anchor: "#Q3" },
      what: "wikilink heading anchor dropped", detail: "Roadmap#Q3",
    },
    {
      node: "vault/Sketches.canvas", code: "canvasNotImported",
      what: "Canvas file not imported", detail: "Canvas has no Markdown representation",
    },
  ],
  pagesCreated: 2, emptyPagesCreated: 0, attachmentsImported: 0,
  attachmentsSkipped: [], deadCrossLinks: 0, published: 0, lossyTitles: false,
};

const textOf = (report: ImportReport, l: string) => {
  lang = l;
  document.body.innerHTML = renderToStaticMarkup(
    createElement(ImportReportView, { report, spaceId: "sp1" }));
  return document.body.textContent ?? "";
};

describe("#725 ②: the report is in the reader's language", () => {
  it("a Japanese reader gets Japanese for what was lost, not the server's English", () => {
    const text = textOf(REPORT, "ja");
    for (const code of ["dataviewKeptAsSource", "headingAnchorDropped", "canvasNotImported"]) {
      expect(text, `ja heading for ${code}`).toContain(bundles.ja.import.degraded[code]);
    }
    // The exact sentences the reviewer quoted off the screen. Named individually because the whole
    // complaint was that these specific words were the English ones left standing.
    expect(text, "no English kind names survive").not.toContain("Dataview query kept as source");
    expect(text, "…nor this one").not.toContain("Canvas file not imported");
    expect(text, "…nor the English detail").not.toContain("has no Markdown representation");
  });

  it("the variables land inside the sentence, rather than as braces", () => {
    const text = textOf(REPORT, "ja");
    expect(text, "no unfilled interpolation reaches the reader").not.toMatch(/\{\{/);
    expect(text, "the count is in the Japanese detail").toContain("1 ブロック");
    expect(text, "the link target too").toContain("Roadmap#Q3");
  });

  it("the page's own name is still there — translating the KIND must not lose the WHICH", () => {
    // The pair is the report: a translated kind with no node under it would be a category, not a
    // finding, and #712's whole rule is that findings are named.
    const text = textOf(REPORT, "ja");
    expect(text).toContain("Weekly Review");
    expect(text).toContain("vault/Sketches.canvas");
  });

  it("English is unchanged — this was a ja defect and en was already right", () => {
    const text = textOf(REPORT, "en");
    expect(text).toContain(bundles.en.import.degraded.dataviewKeptAsSource);
    expect(text).toContain("Weekly Review");
    expect(text, "the count reads as English").toContain("1 block(s)");
  });

  it("a report from a server that does not send codes still says what it knows", () => {
    // Older server, newer screen. The fallback has to be the API's English, NOT a translation key
    // #669 shipped raw keys at readers once, and this is the same shape of mistake one layer down.
    const legacy: ImportReport = {
      ...REPORT,
      degraded: [{ node: "Old page", what: "some future kind of loss", detail: "with a detail" }],
    };
    const text = textOf(legacy, "ja");
    expect(text).toContain("some future kind of loss");
    expect(text).toContain("with a detail");
    expect(text, "no translation key is shown to anybody").not.toContain("import.degraded");
  });

  it("an UNKNOWN code falls back to the English too, instead of printing the key", () => {
    const future: ImportReport = {
      ...REPORT,
      degraded: [{ node: "New page", code: "somethingAddedLater", what: "a kind this build has no words for" }],
    };
    const text = textOf(future, "ja");
    expect(text).toContain("a kind this build has no words for");
    expect(text).not.toContain("import.degraded.somethingAddedLater");
  });
});

describe("#725 ③: the way onward looks like something you can press", () => {
  it("the space link carries the link colour and an underline that is there before hovering", () => {
    // Measured on the real DOM at `master 2083be9d`: same colour as body text, `text-decoration-line
    // none`, 17px beside a button — so it read as a heading. A hover-only underline would not fix
    // that: the reader has to be able to tell before the pointer arrives (and on a touch screen,
    // there is no before).
    textOf(REPORT, "en");
    const link = document.querySelector('[data-testid="import-open-space"]') as HTMLElement | null;
    expect(link, "the link is on the report").not.toBeNull();
    const cls = link?.getAttribute("class") ?? "";
    expect(cls, "it is coloured as a link").toContain("var(--link)");
    expect(cls, "and underlined unconditionally").toMatch(/(^|\s)underline(\s|$)/);
  });
});
