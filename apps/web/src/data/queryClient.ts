import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    // #971: the default networkMode ("online") PAUSES a fetch while the browser reports offline —
    // fetchStatus stays "paused", status stays "pending", isError stays false — so the failure never
    // reaches the `isError`/`error` checks every list surface already has (#888/#895), and 18+ of them
    // fall into their empty-state branch as if the list were genuinely empty. "always" makes the fetch
    // run regardless, so an offline browser's request rejects like any other network failure and every
    // surface's existing failure handling fires correctly.
    queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false, networkMode: "always" },
  },
});
