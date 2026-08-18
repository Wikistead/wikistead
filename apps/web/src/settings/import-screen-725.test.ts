// #725 / ADR-236 §3: one screen, two execution paths, and the import id in the URL.
//
// ADR-227 §7 built the job row so that a report OUTLIVES the connection that started it. A screen
// that held the id in component state would throw that away on the first reload — the property the
// server went to trouble to provide, discarded by the surface that exists to show it. So the pins
// here enter the component the way a RELOAD does: with the id in the query string and nothing in
// memory, and assert that the same import is picked up.
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ImportStatusRow } from "../data/exportApi";

let row: ImportStatusRow | null = null;
let params = new URLSearchParams();

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: "en" } }) }));
vi.mock("react-router-dom", () => ({
  useOutletContext: () => ({ spaceId: "sp1", name: "Docs" }),
  useSearchParams: () => [params, vi.fn()],
  Link: ({ children, ...rest }: { children?: unknown }) => createElement("a", rest as never, children as never),
}));
vi.mock("../session/SessionProvider", () => ({ useSession: () => ({ token: "tok" }) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
// The mock HONOURS the id it is given: the job row exists only when the screen actually asks for it.
// A mock that answered regardless would let a screen keeping the id in component state pass the
// resume pins below — the exact property they exist to check.
let spacePublic: boolean | undefined = false;
vi.mock("../data/queries", () => ({
  useImportStatus: (_spaceId: string, importId: string | null) => ({ data: importId ? row : null }),
  // #746: the screen says "this space is public" beside the publish switch, and only when it is.
  useSpacePublic: () => ({ data: spacePublic }),
}));
vi.mock("../app/product-name", () => ({ useProductName: () => "Wikistead" }));

const { SpaceImportTab } = await import("./SpaceImportTab");
const render = () => renderToStaticMarkup(createElement(SpaceImportTab as never));

const REPORT = {
  degraded: [{ node: "Weekly Review", what: "Dataview query" }],
  pagesCreated: 900, emptyPagesCreated: 0, attachmentsImported: 0,
  attachmentsSkipped: [], deadCrossLinks: 0, published: 0, lossyTitles: false,
};

describe("#725: the screen resumes from the URL", () => {
  it("with no import in the URL it offers the upload form", () => {
    params = new URLSearchParams();
    row = null;
    const html = render();
    expect(html).toContain("space-import-input");
    expect(html).toContain("import-start");
    expect(html).not.toContain("import-running");
  });

  it("entering with ?import=<id> on a RUNNING job shows the progress, not the form", () => {
    // This is the reload: component state is empty, the id comes from the address bar.
    params = new URLSearchParams("import=imp_1");
    row = { id: "imp_1", status: "running", nodesTotal: 900, nodesDone: 120, report: null, error: null };
    const html = render();
    expect(html).toContain("import-running");
    expect(html).toContain("import.progress");
    expect(html).toContain("import.resumable");
    expect(html, "the upload form was offered while an import of this space was running").not.toContain("import-start");
  });

  it("entering with ?import=<id> on a FINISHED job shows that import's report", () => {
    params = new URLSearchParams("import=imp_1");
    row = { id: "imp_1", status: "done", nodesTotal: 900, nodesDone: 900, report: REPORT, error: null };
    const html = render();
    expect(html).toContain("import-report");
    // The report is the job's own, named degradations and all — not a fresh empty screen.
    expect(html).toContain("Weekly Review");
    expect(html).toContain("import-again");
  });

  it("a failed job says so instead of leaving a spinner running forever", () => {
    params = new URLSearchParams("import=imp_1");
    row = { id: "imp_1", status: "failed", nodesTotal: 900, nodesDone: 12, report: null, error: "unzip failed" };
    const html = render();
    expect(html).toContain("import-job-failed");
    expect(html).not.toContain("import-running");
  });

  it("publishing is ON when the screen opens, and the switch is still there to turn it off (#746)", () => {
    // #746 reversed this: the draft default was the one behaviour that differed from every comparable
    // importer, and what it produced was a successful import whose pages read as empty. The switch
    // itself stays — importing quietly to review first is a real thing to want — so BOTH halves are
    // asserted: the control exists, and it starts on.
    params = new URLSearchParams();
    row = null;
    const html = render();
    // The whole control, not the tail after its testid: `data-state` is emitted BEFORE `data-testid`,
    // so a regex anchored on the testid matched a string that could never carry the state. Green in
    // both directions is no pin at all, which is what running the break-check found.
    const sw = /<button[^>]*data-testid="import-publish"[^>]*>/.exec(html)?.[0] ?? "";
    expect(sw, "the publish switch was missing from the form").not.toBe("");
    expect(sw, "the imported pages would have arrived as invisible drafts").toContain('aria-checked="true"');
  });

  it("a PUBLIC space says so beside the switch, and a private one says nothing (#746)", () => {
    // Importing now publishes by default, and in a public space that means readable from outside the
    // moment it lands. Stated as a fact where the choice is made — not as a warning, because a warning
    // that appears on every import is furniture nobody reads.
    params = new URLSearchParams();
    row = null;
    spacePublic = true;
    expect(render(), "the public space names the consequence").toContain("import-public-space-note");
    spacePublic = false;
    expect(render(), "a private space has nothing to say here").not.toContain("import-public-space-note");
    // …and an unanswered query claims nothing either way (the server is the fort regardless).
    spacePublic = undefined;
    expect(render(), "no answer, no claim").not.toContain("import-public-space-note");
    spacePublic = false;
  });
});
