// #914 wiring pin: the guest <Editor> in routes.tsx is handed the uploader. The rule (guestImageUploader)
// and the wiring break separately; the helper's own test cannot see that the route stopped calling it.
// This reads the source for the ONE guest Editor element and asserts the prop is on it — a presence
// check on a single known element, not a search for prose.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("#914 the guest editor is wired to the uploader", () => {
  it("the guestSurface <Editor> carries onUploadImage", () => {
    const src = readFileSync(resolve(import.meta.dirname, "routes.tsx"), "utf8");
    const guestEditors = src.split("\n").filter((l) => l.includes("<Editor ") && l.includes("guestSurface"));
    expect(guestEditors, "exactly one guest-surface Editor element").toHaveLength(1);
    expect(guestEditors[0]).toContain("onUploadImage={onUploadImage}");
    expect(src).toContain("guestImageUploader(capability, pageId, token)");
  });
});
