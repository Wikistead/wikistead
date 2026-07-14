// #328 / ADR-140 increment 2: guest CONNECT rate caps at the collab join point. The bucket math runs
// against a fake Valkey (deterministic counts); readConnectCaps runs against the real RLS-scoped DB.
// Boundaries pinned: the Infinity default does NO Valkey I/O, the per-session bucket isolates one
// flooding guest from a co-editor on the same link, the per-link bucket bounds the link across sessions,
// and a pre-#331 token (no anonId) is still bounded by the link bucket.
import { describe, it, expect } from "vitest";
import type IORedis from "ioredis";
import { bumpRateBucket, normalizeRateMax, readConnectCaps, guestConnectRateAllowed } from "../abuse-rate.js";

// A deterministic in-memory Valkey: INCR + EXPIRE (expiry is not simulated — window rollover is the
// real store's job; these tests only exercise counting within one window).
function fakeValkey(): { client: IORedis; expires: string[] } {
  const counts = new Map<string, number>();
  const expires: string[] = [];
  const client = {
    incr: async (key: string) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return n;
    },
    expire: async (key: string) => {
      expires.push(key);
      return 1;
    },
  } as unknown as IORedis;
  return { client, expires };
}

const poisoned = { incr: () => { throw new Error("valkey must not be touched"); } } as unknown as IORedis;

describe("bumpRateBucket (collab copy of ADR-063)", () => {
  it("allows up to max within the window, then rejects", async () => {
    const { client } = fakeValkey();
    expect(await bumpRateBucket(client, "k", 2, 60)).toBe(true);
    expect(await bumpRateBucket(client, "k", 2, 60)).toBe(true);
    expect(await bumpRateBucket(client, "k", 2, 60)).toBe(false);
  });

  it("sets the window expiry exactly once (first hit)", async () => {
    const { client, expires } = fakeValkey();
    await bumpRateBucket(client, "k", 5, 60);
    await bumpRateBucket(client, "k", 5, 60);
    expect(expires).toEqual(["k"]);
  });

  it("Infinity short-circuits with NO Valkey I/O", async () => {
    await expect(bumpRateBucket(poisoned, "k", Infinity, 60)).resolves.toBe(true);
  });
});

describe("normalizeRateMax", () => {
  it("NULL/0/negative = unlimited; a positive cap passes through", () => {
    expect(normalizeRateMax(null)).toBe(Infinity);
    expect(normalizeRateMax(undefined)).toBe(Infinity);
    expect(normalizeRateMax(0)).toBe(Infinity);
    expect(normalizeRateMax(-1)).toBe(Infinity);
    expect(normalizeRateMax(3)).toBe(3);
  });
});

describe("guestConnectRateAllowed (#328 connect caps)", () => {
  const id = (anon?: string) => ({ tenantId: "tenant_dev", shareLinkId: "link1", anonId: anon });

  it("unlimited caps never touch Valkey", async () => {
    await expect(guestConnectRateAllowed(poisoned, { linkMax: Infinity, sessionMax: Infinity }, id("anon:aaaaaaaaaaaa"))).resolves.toBe(true);
  });

  it("the session bucket trips ONE flooding guest, not a co-editor on the same link", async () => {
    const { client } = fakeValkey();
    const caps = { linkMax: Infinity, sessionMax: 2 };
    expect(await guestConnectRateAllowed(client, caps, id("anon:aaaaaaaaaaaa"))).toBe(true);
    expect(await guestConnectRateAllowed(client, caps, id("anon:aaaaaaaaaaaa"))).toBe(true);
    expect(await guestConnectRateAllowed(client, caps, id("anon:aaaaaaaaaaaa"))).toBe(false); // flooder
    expect(await guestConnectRateAllowed(client, caps, id("anon:bbbbbbbbbbbb"))).toBe(true); // co-editor unaffected
  });

  it("the link bucket bounds the link ACROSS sessions", async () => {
    const { client } = fakeValkey();
    const caps = { linkMax: 2, sessionMax: Infinity };
    expect(await guestConnectRateAllowed(client, caps, id("anon:aaaaaaaaaaaa"))).toBe(true);
    expect(await guestConnectRateAllowed(client, caps, id("anon:bbbbbbbbbbbb"))).toBe(true);
    expect(await guestConnectRateAllowed(client, caps, id("anon:cccccccccccc"))).toBe(false);
  });

  it("a pre-#331 token (no anonId) is still bounded by the link bucket", async () => {
    const { client } = fakeValkey();
    const caps = { linkMax: 1, sessionMax: 1 };
    expect(await guestConnectRateAllowed(client, caps, id(undefined))).toBe(true);
    expect(await guestConnectRateAllowed(client, caps, id(undefined))).toBe(false);
  });
});

describe("readConnectCaps (real DB, RLS-scoped)", () => {
  it("unset knobs (or no settings row) resolve to unlimited", async () => {
    const caps = await readConnectCaps("tenant_dev");
    expect(caps.linkMax).toBe(Infinity);
    expect(caps.sessionMax).toBe(Infinity);
  });
});
