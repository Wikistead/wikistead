// #971: 18 surfaces read `isError` (or a matching early-return/LoadFailed shape — #888/#895's own
// walk already checks that source shape) and correctly draw a failure view when it fires. The bug is
// one layer down: `onlineManager.isOnline() === false` (a real offline browser) makes react-query
// PAUSE the fetch instead of running it — `fetchStatus: "paused"`, `status: "pending"`, `isError:
// false` — so the shape #888 pins never gets asked the question at all, and every one of those 18
// surfaces falls into its empty-state branch while offline, exactly as if the list were genuinely
// empty. #888/#895's pin cannot see this: it reads the SOURCE, and the source is correct.
//
// The fix is one config line (`networkMode: "always"`), not 18 call sites: `always` makes react-query
// attempt the fetch regardless of `onlineManager.isOnline()`, so an offline browser's fetch REJECTS
// (a real network error) instead of pausing, and `isError` becomes true the way every surface already
// expects. Pinned against the query-core machinery directly (no DOM/jsdom needed — `onlineManager`
// tracks its online flag as internal state, not by reading `navigator.onLine`), using the real
// `queryClient`'s own `defaultOptions` so a regression in the app's actual config is what goes red.
import { describe, it, expect, afterEach } from "vitest";
import { QueryClient, QueryObserver, onlineManager } from "@tanstack/react-query";
import { queryClient } from "./queryClient";

afterEach(() => {
  onlineManager.setOnline(true); // never leak "offline" into another test file
});

// Runs one query to settlement (or to "still paused" after a bounded wait) against a FRESH client
// carrying the real queryClient's defaultOptions — so this is a pin on the app's actual config, not a
// hand-rolled one that could drift from it.
async function observeOffline(shouldReject: boolean): Promise<{ fetchStatus: string; status: string }> {
  const client = new QueryClient({ defaultOptions: queryClient.getDefaultOptions() });
  const observer = new QueryObserver(client, {
    queryKey: [`971-offline-probe-${Math.random()}`],
    queryFn: () => (shouldReject ? Promise.reject(new Error("network unreachable")) : Promise.resolve("ok")),
    retry: false,
  });
  const settled = new Promise<{ fetchStatus: string; status: string }>((resolve) => {
    const unsubscribe = observer.subscribe((r) => {
      if (r.fetchStatus !== "fetching") {
        unsubscribe();
        resolve({ fetchStatus: r.fetchStatus, status: r.status });
      }
    });
  });
  observer.refetch();
  // A query paused offline never settles on its own — bound the wait so THAT case reports "still
  // paused" instead of hanging the test file forever.
  const timeout = new Promise<{ fetchStatus: string; status: string }>((resolve) =>
    setTimeout(() => resolve({ fetchStatus: "paused", status: "pending" }), 300));
  return Promise.race([settled, timeout]);
}

describe("#971: an offline browser must fail a query loudly, not pause it silently", () => {
  it("the app's queryClient sets networkMode: \"always\" (not the react-query default)", () => {
    expect(queryClient.getDefaultOptions().queries?.networkMode, "an offline browser will otherwise pause every list fetch instead of failing it")
      .toBe("always");
  });

  it("with that config, an offline fetch REJECTS (isError) instead of pausing (fetchStatus stays fetching→error, never paused)", async () => {
    onlineManager.setOnline(false);
    const r = await observeOffline(true);
    expect(r.fetchStatus, "the fetch must actually run — not stay paused — while offline").not.toBe("paused");
    expect(r.status, "a failed fetch is an error, not a still-pending/empty state").toBe("error");
  });

  it("a genuinely successful fetch is unaffected by being offline-tolerant (always still means always try)", async () => {
    onlineManager.setOnline(false);
    const r = await observeOffline(false);
    expect(r.status).toBe("success");
  });
});
