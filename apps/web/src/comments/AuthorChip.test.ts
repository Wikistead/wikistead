import { describe, it, expect } from "vitest";
import { authorLabel, isGuestSub } from "./AuthorChip";

// #208: the comment author label formats the raw identity for DISPLAY only (authz is unaffected).
describe("authorLabel (#208)", () => {
  it("shortens a guest UUID to a stable short label", () => {
    const sub = "guest:3ca39b02-d803-4362-a976-90a7b5bdc46c";
    expect(isGuestSub(sub)).toBe(true);
    expect(authorLabel(sub, "Guest")).toBe("Guest 3ca3");
    // stable: the same guest always formats the same
    expect(authorLabel(sub, "Guest")).toBe(authorLabel(sub, "Guest"));
    // localized guest word is respected
    expect(authorLabel(sub, "ゲスト")).toBe("ゲスト 3ca3");
  });

  it("#331: shortens an `anon:` pseudonym the same way (Guest 7f3a — never the raw hex)", () => {
    const sub = "anon:7f3a1b2c3d4e";
    expect(isGuestSub(sub)).toBe(true);
    expect(authorLabel(sub, "Guest")).toBe("Guest 7f3a");
    expect(authorLabel(sub, "ゲスト")).toBe("ゲスト 7f3a");
  });

  it("uses the email local-part for a member email sub", () => {
    expect(isGuestSub("alice@example.com")).toBe(false);
    expect(authorLabel("alice@example.com", "Guest")).toBe("alice");
  });

  it("falls back to the raw sub for a non-email member id", () => {
    expect(authorLabel("oidc-sub-123", "Guest")).toBe("oidc-sub-123");
  });
});
