// #725 / ADR-236 §4: the rules the import report must keep, pinned on the component that renders it.
//
// ADR-227 built the report to NAME what did not survive, node by node. The affordance that shipped
// before this screen flattened it into a toast of two numbers, which is the failure the report exists
// to prevent — so the pins here are about naming, not about layout
//
// 1. every degradation appears BY NAME (break-check: render a count instead and this goes red),
// 2. the draft-default sentence is on the report (the line every first-time importer needs), and
// 3. `lossyTitles` is a fact, not a warning. (ADR-236 called it permanently true for third-party
// imports; #712 has since cleared it for those server-side, so it now means "our own export
// arrived without its manifest". The rendering rule is unchanged — it says where titles came
// from, and dressing that as an alarm is what teaches people to skip alarms.)
//
// The prose itself lives in the locale files, so the sentences are checked there: a test that only
// asserted the KEY renders would stay green if the sentence were emptied.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../i18n/locales/en.json";
import ja from "../i18n/locales/ja.json";
import type { ImportReport } from "../data/exportApi";

// `t` returns the key, so an assertion about a NAME cannot accidentally pass on translated prose.
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }) }));
vi.mock("react-router-dom", () => ({
  Link: ({ children, ...rest }: { children?: unknown }) => createElement("a", rest as never, children as never),
}));

const { ImportReportView } = await import("./SpaceImportTab");

const REPORT: ImportReport = {
  degraded: [
    { node: "Weekly Review", what: "Dataview query", detail: "table from #daily" },
    { node: "Roadmap", what: "Dataview query" },
    { node: "Sketches", what: "Canvas file" },
  ],
  pagesCreated: 12,
  emptyPagesCreated: 1,
  attachmentsImported: 4,
  attachmentsSkipped: [{ name: "big.psd", reason: "storage quota" }],
  deadCrossLinks: 2,
  published: 0,
  lossyTitles: true,
};

const render = (report: ImportReport) =>
  renderToStaticMarkup(createElement(ImportReportView as never, { report, spaceId: "sp1" } as never));

describe("#725: the import report names what did not survive", () => {
  it("renders every degraded node by name, under the shape that did not survive", () => {
    const html = render(REPORT);
    for (const d of REPORT.degraded) {
      expect(html, `the report did not name ${d.node}`).toContain(d.node);
    }
    // Grouped by `what`: the shape is named once, not once per row.
    expect(html.split("Dataview query").length - 1, "the group heading was repeated per node").toBe(1);
    expect(html).toContain("Canvas file");
    // The detail rides along with the node it belongs to.
    expect(html).toContain("table from #daily");
  });

  it("a report with degradations renders more than a number for them", () => {
    // The break-check in words: if this component ever rendered `degraded.length` in place of the
    // names, the assertions above would fail. This one states the other half — nothing about the
    // count alone can satisfy the section.
    const html = render(REPORT);
    const withoutNames = REPORT.degraded.every((d) => !html.includes(d.node));
    expect(withoutNames, "the section rendered without naming any node").toBe(false);
  });

  it("names skipped attachments with their reason, so a missing file is never silent", () => {
    const html = render(REPORT);
    expect(html).toContain("big.psd");
    expect(html).toContain("import.skippedQuota");
  });

  it("states the draft default when nothing was published", () => {
    expect(render(REPORT)).toContain("import.draftNotice");
  });

  it("does not state the draft default when the import published as it went", () => {
    const html = render({ ...REPORT, published: 12 });
    expect(html).not.toContain("import.draftNotice");
    expect(html).toContain("import.publishedNotice");
  });

  it("shows lossyTitles as a fact, not as a warning", () => {
    const html = render(REPORT);
    expect(html).toContain("import.lossyTitles");
    // Rendering it in the destructive treatment would put an alarm on a fact about titles.
    const line = /<p[^>]*data-testid="import-lossy-titles"[^>]*>/.exec(html)?.[0] ?? "";
    expect(line, "the titles line was rendered in the error treatment").not.toContain("text-destructive");
  });

  it("omits lossyTitles entirely when the archive carried its own titles", () => {
    expect(render({ ...REPORT, lossyTitles: false })).not.toContain("import.lossyTitles");
  });
});

describe("#725: the sentences themselves", () => {
  const copy = {
    en: en as unknown as Record<string, Record<string, string>>,
    ja: ja as unknown as Record<string, Record<string, string>>,
  };

  it("the draft-default sentence says what a reader will otherwise see", () => {
    // Not "is non-empty": the point of the line is that the pages LOOK empty until they are published,
    // and a sentence that lost that half would still be a sentence.
    expect(copy.en.import!.draftNotice!.toLowerCase()).toContain("draft");
    expect(copy.en.import!.draftNotice!.toLowerCase()).toContain("publish");
    expect(copy.ja.import!.draftNotice!).toContain("下書き");
    expect(copy.ja.import!.draftNotice!).toContain("公開");
  });

  it("the 409 sentence tells the reader what to do, since the server sends no id to link to", () => {
    // ADR-236 §5: the refusal carries no import id, so the honest offer is "wait and reload" rather
    // than a link the screen cannot build. #712 owns adding the id.
    expect(copy.en.import!.busy!.toLowerCase()).toContain("reload");
    expect(copy.ja.import!.busy!).toContain("再読み込み");
  });
});
