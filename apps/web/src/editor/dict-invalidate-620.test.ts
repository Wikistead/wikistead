// #620: a dropped invalidation is not a delay.
//
// The dictionary ping was throttled by DISCARDING anything inside a 2s window. Measured on the device:
// #534's background fill publishes a ping of its own on every cold dictionary load, so a rename landing
// 1.1s later had its ping thrown away — and the next refetch was the 120s TTL, which is how a stale
// coloured link survived a rename that the ADR-104 Finding B design says it must not survive.
//
// The window still exists (a burst of reindex pings must cost one round-trip, which is what it was
// for). What must not come back is the DROP: a ping inside the window schedules the refetch, it does
// not lose it. Pinned on the source because the behaviour lives in a React callback wired to a
// WebSocket — the e2e (title-links-224 anti-test 4) measures the effect end to end, and this keeps the
// shape from regressing quietly between those runs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(import.meta.dirname, "./Editor.tsx"), "utf8");
const handler = (() => {
  const start = src.indexOf("const onDictStateless");
  expect(start, "the dict ping handler exists").toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("}, [queryClient]);", start));
})();

describe("#620: the dictionary ping is coalesced, never discarded", () => {
  it("a ping inside the window schedules a refetch instead of returning empty-handed", () => {
    // the defect's shape: a bare `return` guarded only by the elapsed-time comparison
    expect(handler, "no early return that loses the ping").not.toMatch(/if \(\s*now - dict\w+\.current < 2000\s*\) return;/);
    expect(handler, "the late ping is deferred").toMatch(/setTimeout\(\s*run\s*,\s*2000 - since\s*\)/);
  });

  it("a burst still costs ONE round-trip (the reason the window exists)", () => {
    // a second ping while one is already scheduled must not schedule another
    expect(handler).toMatch(/if \(dictPendingTimer\.current !== null\) return;/);
  });

  it("the first ping in a quiet period is immediate — the security-timing signal is not delayed by design", () => {
    expect(handler).toMatch(/if \(since >= 2000\) \{ run\(\); return; \}/);
  });

  it("the scheduled refetch is cancelled when the editor goes away", () => {
    // a timer firing into an unmounted component is the other half of owning one
    expect(src).toMatch(/clearTimeout\(dictPendingTimer\.current\)/);
  });
});
