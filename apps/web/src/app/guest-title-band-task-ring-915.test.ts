// #915 wiring pin: the guest surface had onToggleTask (checkboxes toggle) but no onTaskProgress
// (the title-band ring never updates) — a member could not tell, but a guest saw a checkbox flip
// with no progress feedback anywhere. The rule (ProgressRing renders nothing at 0/0) and the
// wiring break separately (rules-and-wiring-break-separately), so this reads the source for the
// ONE guest Editor element and the guest title band, rather than re-testing ProgressRing itself.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("#915 the guest surface shows the title-band task-progress ring", () => {
  const src = readFileSync(resolve(import.meta.dirname, "routes.tsx"), "utf8");

  it("the guestSurface <Editor> carries onTaskProgress", () => {
    const guestEditors = src.split("\n").filter((l) => l.includes("<Editor ") && l.includes("guestSurface"));
    expect(guestEditors, "exactly one guest-surface Editor element").toHaveLength(1);
    expect(guestEditors[0]).toContain("onTaskProgress={onTaskProgress}");
  });

  it("the guest title band renders the same band-task-ring the member surface does", () => {
    const guestBandStart = src.indexOf('data-testid="guest-title-band"');
    expect(guestBandStart, "guest-title-band testid not found").toBeGreaterThan(-1);
    // The ring lives within the band's own block — the next ~1200 characters of source comfortably
    // covers the title + ring markup without reaching into an unrelated later section.
    const around = src.slice(guestBandStart, guestBandStart + 1200);
    expect(around).toContain('data-testid="band-task-ring"');
    expect(around).toContain("<ProgressRing done={taskProgress.done} total={taskProgress.total}");
  });

  it("view guests get the ring too — onToggleTask stays edit-gated, onTaskProgress does not", () => {
    const guestEditorLine = src.split("\n").find((l) => l.includes("<Editor ") && l.includes("guestSurface"))!;
    expect(guestEditorLine).toContain("onToggleTask={canEdit ? onToggleTask : undefined}");
    expect(guestEditorLine).not.toContain("onTaskProgress={canEdit ?"); // not capability-gated
  });
});
