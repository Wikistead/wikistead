// @vitest-environment happy-dom
//
// #1046: #1014's own pin (space-home-load-failed-1014.test.ts) mocks `useResolvedSpaceState`
// wholesale to drive SpaceHomeRoute's three branches — it proves the ROUTE reacts correctly to
// `isError`, but never calls the real hook, so nothing in this tree checked that
// `useResolvedSpaceState` actually PASSES `isError` through from the underlying query. Measured:
// hard-coding `isError: false` inside the hook left #1014's pins, and the #888 census, green.
//
// This pins the hook itself, with `@tanstack/react-query`'s `useQuery` stubbed to the two states
// that matter (failed / still fine) so the assertion is about queries.ts's own plumbing, not
// react-query's internals (#971 already owns those) or the network.
import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

interface QueryState { data: unknown; isPending: boolean; isError: boolean; refetch: () => void }
let queryState: QueryState;

vi.mock("@tanstack/react-query", () => ({ useQuery: () => queryState }));
vi.mock("../session/SessionProvider", () => ({ useSession: () => ({ token: "t" }) }));
vi.mock("./apiClient", () => ({ apiFetch: async () => ({ spaces: {} }), assetUrl: (p: string) => p }));

const { useResolvedSpaceState } = await import("./queries");

function Probe({ id }: { id: string | null }) {
  const s = useResolvedSpaceState(id);
  return createElement("div", {
    "data-testid": "probe",
    "data-error": String(s.isError),
    "data-pending": String(s.isPending),
    "data-data-is-undefined": String(s.data === undefined),
  });
}

afterEach(() => { vi.clearAllMocks(); });

describe("#1046 useResolvedSpaceState surfaces the underlying query's isError, not just data===undefined", () => {
  it("a failed fetch (retries exhausted) reports isError:true with data left undefined", () => {
    queryState = { data: undefined, isPending: false, isError: true, refetch: () => {} };
    const html = renderToStaticMarkup(createElement(Probe, { id: "space-1" }));
    expect(html).toContain('data-error="true"');
    expect(html).toContain('data-data-is-undefined="true"');
  });

  it("still in flight: isPending:true, isError:false — the OTHER undefined-data state, told apart", () => {
    queryState = { data: undefined, isPending: true, isError: false, refetch: () => {} };
    const html = renderToStaticMarkup(createElement(Probe, { id: "space-1" }));
    expect(html).toContain('data-error="false"');
    expect(html).toContain('data-pending="true"');
  });

  it("no id: isError is false regardless of what the (disabled) underlying query reports", () => {
    queryState = { data: undefined, isPending: false, isError: true, refetch: () => {} };
    const html = renderToStaticMarkup(createElement(Probe, { id: null }));
    expect(html).toContain('data-error="false"');
  });
});
