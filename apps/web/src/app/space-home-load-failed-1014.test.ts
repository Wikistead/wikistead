// @vitest-environment happy-dom
// #1014: useResolvedSpace's `data === undefined` covered both "still loading" and "retries
// exhausted, the fetch failed" — SpaceHomeRoute had no signal to tell the two apart, so a genuine
// /spaces/resolve failure fell through to the same space-home-empty panel a home-less space
// renders on a SUCCESSFUL fetch. No error, no retry — a permanent, silent blank screen.
//
// This renders SpaceHomeRoute directly in each of the three states and checks they draw three
// different things — the failure panel specifically must not read as the empty panel, and its
// retry button must call through to the query's own refetch, not just exist with the right label.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

interface ResolvedSpaceState {
  data: unknown;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

const refetch = vi.fn();
let state: ResolvedSpaceState;

vi.mock("react-router-dom", () => ({
  useParams: () => ({ spaceId: "space-1" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
  Navigate: () => null,
  Route: () => null,
  Routes: () => null,
  Link: (props: { children?: unknown }) => props.children ?? null,
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useQuery: () => ({ data: undefined, isPending: true, isError: false }),
  useQueries: () => [],
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("../session/SessionProvider", () => ({
  useSession: () => ({ status: "authed", logout: vi.fn(), token: "tok" }),
}));
vi.mock("./ActiveSpace", () => ({ useActiveSpace: () => ({ setActiveSpaceId: vi.fn() }) }));
// The shell chrome (header/branding/theme) is not what this ticket is about — stubbed to its
// content so the assertions below are entirely about SpaceHomeRoute's own branch, not AppShell's.
vi.mock("./AppShell", () => ({ AppShell: ({ children }: { children: unknown }) => children }));
vi.mock("../data/queries", () => ({ useResolvedSpaceState: () => state }));

const { SpaceHomeRoute } = await import("./routes");

afterEach(() => {
  vi.clearAllMocks();
});

describe("#1014 SpaceHomeRoute distinguishes loading, error, and empty-success", () => {
  it("loading: never shows the failure panel", () => {
    state = { data: undefined, isPending: true, isError: false, refetch };
    const html = renderToStaticMarkup(createElement(SpaceHomeRoute));
    expect(html, "an in-flight fetch must not read as a failed one").not.toContain("space-home-failed");
  });

  it("error: shows the failure panel (not the empty panel), and retry calls the query's refetch", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state = { data: undefined, isPending: false, isError: true, refetch };
    const container = document.createElement("div");
    let root!: Root;
    act(() => {
      root = createRoot(container);
      root.render(createElement(SpaceHomeRoute));
    });
    expect(container.querySelector('[data-testid="space-home-failed"]'), "the failure panel must render").not.toBeNull();
    expect(
      container.querySelector('[data-testid="space-home-empty"]'),
      "a genuine failure must not fall through to the empty panel",
    ).toBeNull();
    const retry = container.querySelector('[data-testid="space-home-failed-retry"]');
    expect(retry, "the failure panel must offer a retry").not.toBeNull();
    act(() => {
      retry!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(refetch, "retry must call the query's own refetch").toHaveBeenCalledTimes(1);
    act(() => {
      root.unmount();
    });
  });

  it("success-but-empty: shows the empty panel (not the failure panel)", () => {
    state = { data: { id: "space-1", name: "Test Space", capability: "edit" }, isPending: false, isError: false, refetch };
    const html = renderToStaticMarkup(createElement(SpaceHomeRoute));
    expect(html, "a resolved, home-less space must still render the empty panel").toContain("space-home-empty");
    expect(html, "a successful fetch must not render the failure panel").not.toContain("space-home-failed");
  });
});
