import { describe, it, expect } from "vitest";
import { selectGuestConnectionsToClose, parseRevokeMessage, type ConnectionLike } from "../revoke.js";

// #106 / ADR-028: deciding WHO gets disconnected on a share-link revoke is security-critical,
// so it lives in a pure function and is exhaustively tested. Over-closing would disrupt
// unrelated sessions (regression + mini-DoS); under-closing would leave a revoked guest
// editing. Both directions are asserted.
const conn = (principal: unknown): ConnectionLike => ({ context: { principal: principal as never }, close: () => {} });
const guest = (shareLinkId: string) => conn({ kind: "guest", shareLinkId });
const member = () => conn({ kind: "member", userId: "u" });

describe("selectGuestConnectionsToClose", () => {
  it("selects every guest on the revoked link (multiple guests, one link)", () => {
    const a = guest("L1"), b = guest("L1");
    const sel = selectGuestConnectionsToClose([a, member(), b], "L1");
    expect(sel).toEqual([a, b]); // none missed
  });

  it("never selects a member", () => {
    expect(selectGuestConnectionsToClose([member(), member()], "L1")).toEqual([]);
  });

  it("never selects a guest on a DIFFERENT link (other sessions untouched)", () => {
    const other = guest("L2");
    expect(selectGuestConnectionsToClose([other], "L1")).toEqual([]);
  });

  it("returns [] for an empty shareLinkId (no accidental mass-close)", () => {
    expect(selectGuestConnectionsToClose([guest(""), member()], "")).toEqual([]);
  });

  it("tolerates a connection with no context/principal", () => {
    const bare = { close: () => {} } as ConnectionLike;
    const g = guest("L1");
    expect(selectGuestConnectionsToClose([bare, g], "L1")).toEqual([g]);
  });
});

describe("parseRevokeMessage", () => {
  it("parses a valid payload", () => {
    expect(parseRevokeMessage(JSON.stringify({ shareLinkId: "L1" }))).toEqual({ shareLinkId: "L1" });
  });

  it("returns null for malformed JSON", () => {
    expect(parseRevokeMessage("not json")).toBeNull();
  });

  it("returns null when shareLinkId is missing or empty", () => {
    expect(parseRevokeMessage("{}")).toBeNull();
    expect(parseRevokeMessage(JSON.stringify({ shareLinkId: "" }))).toBeNull();
    expect(parseRevokeMessage(JSON.stringify({ shareLinkId: 123 }))).toBeNull();
  });
});
