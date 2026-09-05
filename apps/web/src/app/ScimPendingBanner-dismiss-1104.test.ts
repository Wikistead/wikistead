// @vitest-environment happy-dom
// #1104 (owner ruling, #983's review): the pending-removal banner used to have no close
// affordance and sat at the top of every page for the whole time a removal stayed deferred. This
// pins the four accepted criteria: ① dismissable while pending ② stays gone for the rest of the
// SAME session ③ reappears in a NEW session (never permanently gone — ADR-275 §4 relies on the
// in-product record staying reachable) ④ never renders once the pending state itself resolves.
//
// No @testing-library/react in this package (a licence gate + review) — real react-dom/client
// rendering instead, the pattern `space-home-load-failed-1014.test.ts` established. `sessionStorage`
// is REAL here (happy-dom provides it), not mocked — the mechanism under test IS which Storage the
// dismiss survives in, so faking it would test nothing.
//
// #1104 review: `usePendingRemovalNotice()`'s real return type is `boolean | undefined`
// (`fetchPendingRemovalNotice` resolves to `true`/`false`; `undefined` is the query's own in-flight
// state, before it has answered at all). An earlier version of this pin modelled the mock as
// `{class: string} | null | undefined`, using `null` for "resolved, nothing pending" and `undefined`
// for "no pending removal" — collapsing the SAME "loading" and "resolved false" states the shipped
// component itself collapsed (`if (pending) return` cleared the dismissal on every not-yet-answered
// mount). Modelling the real boolean type is what makes ② below actually exercise the defect: a
// reload lands on `pending === undefined` before the query answers, with a same-session dismissal
// already in sessionStorage from before the reload.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";

let pending: boolean | undefined;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("../data/queries", () => ({ usePendingRemovalNotice: () => ({ data: pending }) }));

const { ScimPendingBanner } = await import("./ScimPendingBanner");

const DISMISSED_KEY = "scim-pending-banner-dismissed";

function render(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  let root!: Root;
  act(() => { root = createRoot(container); root.render(createElement(ScimPendingBanner)); });
  return { container, root };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear();
  pending = true;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("#1104: the pending-removal banner is dismissable, per-session", () => {
  it("renders nothing while the query is still loading (pending undefined)", () => {
    pending = undefined;
    const { container } = render();
    expect(container.querySelector('[data-testid="scim-pending-banner"]')).toBeNull();
  });

  it("renders nothing once the query resolves to no pending removal (false)", () => {
    pending = false;
    const { container } = render();
    expect(container.querySelector('[data-testid="scim-pending-banner"]')).toBeNull();
  });

  it("① renders while pending, with a dismiss affordance", () => {
    const { container } = render();
    expect(container.querySelector('[data-testid="scim-pending-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="scim-pending-banner-dismiss"]'), "no close button to dismiss with").not.toBeNull();
  });

  it("① clicking dismiss hides the banner and records it in sessionStorage", () => {
    const { container, root } = render();
    const btn = container.querySelector('[data-testid="scim-pending-banner-dismiss"]')!;
    act(() => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector('[data-testid="scim-pending-banner"]'), "dismissing must hide it").toBeNull();
    expect(sessionStorage.getItem(DISMISSED_KEY)).toBe("1");
    act(() => { root.unmount(); });
  });

  it("② a fresh mount in the SAME session (sessionStorage already marked) stays gone", () => {
    sessionStorage.setItem(DISMISSED_KEY, "1");
    const { container } = render();
    expect(container.querySelector('[data-testid="scim-pending-banner"]'), "still pending, still the same session — must not reappear").toBeNull();
  });

  // ⚠️ break-check target: a reload lands here FIRST — sessionStorage still carries last
  // session's dismissal, but the query has not answered yet. The shipped defect cleared the
  // dismissal on this exact mount (treating "loading" as "nothing pending"), so the banner came back
  // the instant the query resolved a few hundred ms later.
  it("② surviving a reload: mounts with a stale dismissal WHILE the query is still loading, then the query confirms still-pending — the banner must stay gone throughout", () => {
    sessionStorage.setItem(DISMISSED_KEY, "1");
    pending = undefined; // the exact moment right after a reload, before the query answers
    const { container, root } = render();
    expect(container.querySelector('[data-testid="scim-pending-banner"]'), "must not reappear while still loading").toBeNull();
    expect(sessionStorage.getItem(DISMISSED_KEY), "loading must not wipe the dismissal record").toBe("1");

    pending = true; // the query answers: still the SAME pending removal
    act(() => { root.render(createElement(ScimPendingBanner)); });
    expect(container.querySelector('[data-testid="scim-pending-banner"]'), "confirmed still-pending must not undo the earlier dismissal").toBeNull();
    expect(sessionStorage.getItem(DISMISSED_KEY)).toBe("1");
    act(() => { root.unmount(); });
  });

  it("③ a NEW session (sessionStorage cleared) shows it again", () => {
    sessionStorage.setItem(DISMISSED_KEY, "1");
    sessionStorage.clear(); // what a genuinely new session looks like from this component's vantage
    const { container } = render();
    expect(container.querySelector('[data-testid="scim-pending-banner"]'), "a new session must not inherit the old dismissal").not.toBeNull();
  });

  it("④ once the pending state resolves to false, the banner is gone AND the dismissal is cleared for next time", () => {
    sessionStorage.setItem(DISMISSED_KEY, "1");
    pending = false; // resolved — nothing pending any more
    const { container } = render();
    expect(container.querySelector('[data-testid="scim-pending-banner"]')).toBeNull();
    expect(sessionStorage.getItem(DISMISSED_KEY), "a stale dismissal must not pre-suppress a LATER, unrelated pending state").toBeNull();
  });

  it("④ a live transition (dismiss → resolve → a LATER, unrelated pending state) shows the new one", () => {
    const { container, root } = render();
    const btn = container.querySelector('[data-testid="scim-pending-banner-dismiss"]')!;
    act(() => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector('[data-testid="scim-pending-banner"]')).toBeNull();

    pending = false; // the first removal resolved
    act(() => { root.render(createElement(ScimPendingBanner)); });
    expect(sessionStorage.getItem(DISMISSED_KEY), "resolving must clear the old dismissal").toBeNull();

    pending = true; // an unrelated LATER pending state
    act(() => { root.render(createElement(ScimPendingBanner)); });
    expect(container.querySelector('[data-testid="scim-pending-banner"]'), "the old dismissal must not carry over to a new occurrence").not.toBeNull();
    act(() => { root.unmount(); });
  });
});
