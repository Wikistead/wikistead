// #979 / ADR-268 §3, ruling NoticeBand replaces the wks-left-bar class everywhere. Calling the
// component directly (it is a plain function — no @testing-library/react in this package, see
// hint-order-881.test.ts) returns the React ELEMENT TREE, inspectable via .props without a DOM
// renderer: real assertions on which icon, which colour, and which required prop, not string matching.
import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { TriangleAlert, Info } from "lucide-react";
import { NoticeBand } from "./NoticeBand";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- inspecting an opaque React element
// tree without a renderer; the specific fields each test reads are what's actually asserted.
const p = (el: ReactElement): any => el.props;

describe("NoticeBand", () => {
  it("kind=\"danger\" uses the danger token and the warning-triangle icon (ruling 群1)", () => {
    const el = NoticeBand({ kind: "danger", title: "T", children: "B" });
    const [iconEl, textEl] = p(el).children as [ReactElement, ReactElement];
    expect(iconEl.type, "the icon is the warning triangle, not the danger octagon or anything else").toBe(TriangleAlert);
    expect(p(iconEl).style.color).toBe("var(--danger)");
    expect(p(el).style.borderColor).toContain("var(--danger)");
    expect(p(el).style.backgroundColor).toContain("var(--danger)");
    const [titleEl] = p(textEl).children as [ReactElement, ReactElement];
    expect(p(titleEl).style.color).toBe("var(--danger)");
  });

  it("kind=\"info\" uses the accent token and the info-circle icon (ruling 群2)", () => {
    const el = NoticeBand({ kind: "info", title: "T", children: "B" });
    const [iconEl] = p(el).children as [ReactElement, ReactElement];
    expect(iconEl.type).toBe(Info);
    expect(p(iconEl).style.color).toBe("var(--accent)");
    expect(p(el).style.borderColor).toBe("var(--border)"); // info keeps the ordinary border; only danger gets the stronger mixed border
    expect(p(el).style.backgroundColor).toContain("var(--accent)");
  });

  it("passes through testId, role and title/children content", () => {
    const el = NoticeBand({ kind: "danger", title: "My Title", children: "My body", testId: "my-band", role: "alert" });
    expect(p(el)["data-testid"]).toBe("my-band");
    expect(p(el).role).toBe("alert");
    expect(p(el)["data-notice-kind"]).toBe("danger");
    const [, textEl] = p(el).children as [ReactElement, ReactElement];
    const [titleEl, bodyEl] = p(textEl).children as [ReactElement, ReactElement];
    expect(p(titleEl).children).toBe("My Title");
    expect(p(bodyEl).children).toBe("My body");
  });

  it("merges a caller className without dropping the base layout classes", () => {
    const el = NoticeBand({ kind: "info", title: "T", children: "B", className: "mb-5" });
    expect(p(el).className).toContain("mb-5");
    expect(p(el).className, "the base flex/panel classes must survive alongside the caller's").toContain("flex");
  });
});
