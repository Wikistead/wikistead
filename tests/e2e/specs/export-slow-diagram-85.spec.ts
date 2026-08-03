import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScratch, enterEdit, sleep, API } from "../helpers";

// #85 (review rejection ④): a diagram the host draws over the network lands in the file even when the
// renderer is slow.
//
// The report was "the PlantUML block came out as its source, while mermaid on the same page came out as
// a picture". The wiring was already there, so the difference is WHEN each answers: mermaid draws in
// process, PlantUML is a round trip to a render service. The export used to sample the markup for
// stillness with a 4s ceiling, so a renderer answering in 4.1s produced a file with the source card in
// it — silently, and only sometimes. Every existing gate missed it because the stub answers instantly.
//
// This one answers in SIX SECONDS on purpose. It is the only test in the suite where the delay is the
// subject rather than an annoyance.
const SLOW_MS = 6_000;
const PLANTUML_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const FIXTURE = ["```plantuml", "@startuml", "A -> B", "@enduml", "```", "", "tail text", ""].join("\n");

test("#85: a slow diagram renderer still puts a picture in the saved file", async ({ page }) => {
  test.setTimeout(240_000);
  await page.route("**/plantuml/render", async (route) => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    await route.fulfill({ status: 200, contentType: "image/png", body: PLANTUML_PNG });
  });

  const id = await openScratch(page, `slowdiag-${Date.now()}`);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.evaluate((text) => {
    const el = document.querySelector("[data-pane=preview] .cm-content") as { cmView?: { view?: unknown }; cmTile?: { view?: unknown } } | null;
    const view = (el?.cmView?.view ?? el?.cmTile?.view) as { state: { doc: { length: number } }; dispatch(t: unknown): void } | undefined;
    if (!view) throw new Error("no editor view to write the fixture into");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }, FIXTURE);
  await sleep(1200);
  await page.evaluate(async ({ api, pageId }) => {
    await fetch(`${api}/pages/${pageId}/publish`, { method: "POST", headers: { Authorization: "Bearer dev-token" } });
  }, { api: API, pageId: id });
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(1500);

  await page.click("[data-testid=page-overflow-trigger]");
  const dl = page.waitForEvent("download");
  await page.getByTestId("export-page-html").click();
  const savedPath = join(mkdtempSync(join(tmpdir(), "wks-slowdiag-")), "export.html");
  await (await dl).saveAs(savedPath);

  const bytes = readFileSync(savedPath, "utf8");
  expect(bytes, "the figure is in the file as bytes, not as its source").toContain("data:image/png");
  expect(bytes, "and the source card did not travel in its place").not.toContain("@startuml");
});
