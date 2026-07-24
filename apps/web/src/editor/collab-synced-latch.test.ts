import { describe, it, expect, vi } from "vitest";
import { makeSyncedLatch } from "./collab";

// #502 / ADR-184 slice 2b: the seed-timing latch. A co-occupied island seeds its shared ephemeral body ONLY
// after the room's initial sync — the precondition that lets the seeded-guard close the join race. The latch
// must (a) fire a callback registered BEFORE sync when sync lands, (b) fire a callback registered AFTER sync
// IMMEDIATELY (a late seeder must not miss the edge), and (c) be idempotent (a second sync never re-fires).

describe("makeSyncedLatch (#502 seed-after-sync timing)", () => {
  it("starts un-synced", () => {
    expect(makeSyncedLatch().synced).toBe(false);
  });

  it("fires a BEFORE-sync waiter exactly once when sync lands", () => {
    const latch = makeSyncedLatch();
    const cb = vi.fn();
    latch.onSynced(cb);
    expect(cb).not.toHaveBeenCalled(); // not synced yet → deferred
    latch.markSynced();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(latch.synced).toBe(true);
  });

  it("fires an AFTER-sync waiter IMMEDIATELY (a late seeder must not miss the edge)", () => {
    const latch = makeSyncedLatch();
    latch.markSynced();
    const cb = vi.fn();
    latch.onSynced(cb);
    expect(cb).toHaveBeenCalledTimes(1); // already synced → fire now, synchronously
  });

  it("is idempotent — a second markSynced never re-fires the waiters", () => {
    const latch = makeSyncedLatch();
    const cb = vi.fn();
    latch.onSynced(cb);
    latch.markSynced();
    latch.markSynced(); // a duplicate sync event (reconnect) must NOT double-fire the seed
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires ALL before-sync waiters once, in order", () => {
    const latch = makeSyncedLatch();
    const order: number[] = [];
    latch.onSynced(() => order.push(1));
    latch.onSynced(() => order.push(2));
    latch.markSynced();
    expect(order).toEqual([1, 2]);
  });
});
