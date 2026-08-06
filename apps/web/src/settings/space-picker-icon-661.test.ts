// #661the space picker draws each space the way the rest of the product draws a space.
//
// The point of asserting this in source rather than only in a browser is which COMPONENT is used. A
// hand-rolled circle with the first letter in it looks identical in a screenshot and then goes stale
// the day `SpaceIcon` changes — image handling, the initials fallback, the deterministic colour seed.
// The product already has two surfaces drawing a space row; a third drawing of the same thing is the
// drift this check exists to prevent.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const panel = readFileSync(resolve(import.meta.dirname, "ApiKeysPanel.tsx"), "utf8");
/** Comments name the component to explain the choice; the claim is about what is RENDERED. */
const code = panel.split("\n").map((l) => l.replace(/^\s*(?:\/\/|\*|\/\*).*$/, "")).join("\n");

describe("#661: the picker uses the product's space icon, not one of its own", () => {
  it("imports the shared component", () => {
    expect(/import \{[^}]*\bSpaceIcon\b[^}]*\} from "\.\.\/ui\/SpaceIcon"/.test(code), "SpaceIcon is imported").toBe(true);
  });

  it("renders it inside the space option row", () => {
    // Anchored to the row rather than to the file: an import that nothing renders would satisfy the
    // case above and leave the rows exactly as plain as they were.
    const row = code.slice(code.indexOf('data-testid="api-key-space-option"'));
    const end = row.indexOf("</label>");
    expect(end, "the option row is still a label").toBeGreaterThan(0);
    expect(/<SpaceIcon\b/.test(row.slice(0, end)), "the row draws the icon").toBe(true);
  });

  it("passes the space's own image, so a configured icon is the one shown", () => {
    const row = code.slice(code.indexOf('data-testid="api-key-space-option"'));
    const tag = row.slice(row.indexOf("<SpaceIcon"), row.indexOf("/>", row.indexOf("<SpaceIcon")));
    // Without `image` every space falls back to initials — indistinguishable from "no icons at all"
    // for a tenant that has not uploaded any, which is exactly how this would ship half-done.
    expect(/image=\{[^}]*iconImageUrl/.test(tag), `the uploaded image is passed :: ${tag}`).toBe(true);
    expect(/id=\{/.test(tag) && /name=\{/.test(tag), "id and name are passed (the initials + colour seed)").toBe(true);
  });
});
