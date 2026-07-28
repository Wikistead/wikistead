// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Eye, EyeOff } from "lucide-react";
import { overflowItems } from "./PageControls";

// #542: a menu item's label and icon point at the same thing — the ACTION it performs. The watch toggle's
// label said the action ("watch" / "unwatch") while its icon showed the current STATE (watching → Eye),
// so each row read as its own opposite: "unwatch" beside an open eye, "watch" beside a crossed-out one.
// The trailing ✓ already carries the state, so the icon follows the label.
const t = (k: string) => k;
const props = (watching: boolean) => [
  { pageId: "p1" } as unknown as Parameters<typeof overflowItems>[0],
  t,
  { page: { watching, disabled: false, toggle: () => {} } } as unknown as Parameters<typeof overflowItems>[2],
] as const;

describe("#542 the watch item's icon points at the action, like its label", () => {
  it("not watching → 'watch' + Eye (start seeing)", () => {
    const item = overflowItems(...props(false)).find((i) => i.testId === "watch-toggle")!;
    expect(item.label).toBe("watch.watch");
    expect((item.icon as { type: unknown }).type, "the icon is the action's").toBe(Eye);
    expect(item.checked).toBe(false);
  });

  it("watching → 'unwatch' + EyeOff (stop seeing) + ✓", () => {
    const item = overflowItems(...props(true)).find((i) => i.testId === "watch-toggle")!;
    expect(item.label).toBe("watch.unwatch");
    expect((item.icon as { type: unknown }).type, "the icon is the action's, the ✓ carries the state").toBe(EyeOff);
    expect(item.checked).toBe(true);
  });
});
