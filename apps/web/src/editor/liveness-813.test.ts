// #813 / ADR-248 §3.1: the rule that decides whether this client's edits are arriving.
//
// The reported accident was a guest whose socket had been refused five minutes earlier, typing into a
// local document, pressing publish, and being told it was published. Every part of the answer was on
// the provider and none of it was read.
import { describe, it, expect } from "vitest";
import { isLive, notLiveReason, type LivenessInputs } from "./liveness";

const LIVE: LivenessInputs = { connected: true, authenticated: true, authorizedScope: "read-write", synced: true };

describe("#813 live means the edits are arriving", () => {
  it("all four conjuncts together, and nothing less", () => {
    expect(isLive(LIVE)).toBe(true);
    // Each one alone is enough to make it false. Asserting the conjunction as a whole would pass a
    // version that dropped one of them, which is exactly the regression this file exists for.
    expect(isLive({ ...LIVE, connected: false })).toBe(false);
    expect(isLive({ ...LIVE, authenticated: false })).toBe(false);
    expect(isLive({ ...LIVE, synced: false })).toBe(false);
    expect(isLive({ ...LIVE, authorizedScope: "readonly" })).toBe(false);
  });

  it("⚠️ a read-only connection is not live, and it is the case with no event to observe", () => {
    // Connected, authenticated AND synced — the state three-quarters of a rule would call healthy —
    // while the server discards every update it is sent. The server answers `writeSyncStatus(false)`
    // and the provider does nothing at all with a false `applied`: no error, no event, no callback.
    // A rule built out of the observable signals alone therefore cannot see this, which is why the
    // scope has to be read rather than inferred.
    const readOnly: LivenessInputs = { ...LIVE, authorizedScope: "readonly" };
    expect(isLive(readOnly)).toBe(false);
    expect(notLiveReason(readOnly)).toBe("read-only");
  });

  it("an unset scope is not read-write — a connection that never answered is not live either", () => {
    // `authorizedScope` starts undefined and is assigned when the server's authenticated message
    // arrives. Treating "not yet told" as permission would open the window this closes.
    expect(isLive({ ...LIVE, authorizedScope: undefined })).toBe(false);
  });

  it("the reason tells a waiting state apart from a lost right", () => {
    // Not cosmetic: three of these end by themselves and one does not. A banner that says
    // "reconnecting…" to somebody whose edit right was withdrawn is telling them to wait for
    // something that will never happen.
    expect(notLiveReason(LIVE)).toBe(null);
    expect(notLiveReason({ ...LIVE, connected: false })).toBe("connecting");
    expect(notLiveReason({ ...LIVE, authenticated: false })).toBe("unauthenticated");
    expect(notLiveReason({ ...LIVE, authorizedScope: "readonly" })).toBe("read-only");
    expect(notLiveReason({ ...LIVE, synced: false })).toBe("syncing");
  });

  it("the reason is decided in the order a connection actually fails", () => {
    // A dropped socket reports `connecting`, not `read-only`, even though the scope from the last
    // connection is still sitting on the provider. Reporting the stale scope would name a cause that
    // is not the current one.
    expect(notLiveReason({ connected: false, authenticated: false, authorizedScope: "readonly", synced: false }))
      .toBe("connecting");
  });
});
