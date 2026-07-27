import { describe, it, expect } from "vitest";
import { overflowItems } from "./PageControls";

// #207: the Print item was shipped GRAYED OUT — both print paths produced a low-fidelity document (the
// live surface is virtualised, so only a screenful printed; the static one leaked raw `:::` and un-rendered
// math). ADR-191 rebuilt the render core and printing now goes through the same server-rendered document
// the HTML export serves, so the seal is lifted. This pins the menu composition: a disabled Print item (or
// one carrying the "temporarily unavailable" hint) means the seal came back.
const t = (k: string) => k;
const props = { pageId: "p1", onPrint: () => {}, onExportHtml: () => {} } as unknown as Parameters<typeof overflowItems>[0];

describe("#207 the ⋯ menu offers Print for real", () => {
  it("the Print item is present and enabled", () => {
    const print = overflowItems(props, t).find((i) => i.testId === "print-page");
    expect(print, "Print is offered").toBeDefined();
    expect(print!.disabled, "…and it is not sealed").toBeFalsy();
    expect((print as { hint?: string }).hint, "no 'temporarily unavailable' hint remains").toBeUndefined();
  });

  it("the HTML export beside it is enabled too (same render core, same seal)", () => {
    const exp = overflowItems(props, t).find((i) => i.testId === "export-page-html");
    expect(exp).toBeDefined();
    expect(exp!.disabled).toBeFalsy();
  });

  it("no Print item at all when the caller offers no print handler", () => {
    const none = overflowItems({ pageId: "p1" } as unknown as Parameters<typeof overflowItems>[0], t);
    expect(none.find((i) => i.testId === "print-page")).toBeUndefined();
  });
});
