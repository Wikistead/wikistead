import { describe, it, expect } from "vitest";
import { authorLabel, isGuestSub } from "./AuthorChip";
import { memberLabel } from "../ui/principal-label";

// #208: the comment author label formats the raw identity for DISPLAY only (authz is unaffected).
describe("authorLabel (#208)", () => {
  it("shortens a guest UUID to a stable short label", () => {
    const sub = "guest:3ca39b02-d803-4362-a976-90a7b5bdc46c";
    expect(isGuestSub(sub)).toBe(true);
    expect(authorLabel(sub, "Guest", "Unnamed member")).toBe("Guest 3ca3");
    // stable: the same guest always formats the same
    expect(authorLabel(sub, "Guest", "Unnamed member")).toBe(authorLabel(sub, "Guest", "Unnamed member"));
    // localized guest word is respected
    expect(authorLabel(sub, "ゲスト", "Unnamed member")).toBe("ゲスト 3ca3");
  });

  it("#331: shortens an `anon:` pseudonym the same way (Guest 7f3a — never the raw hex)", () => {
    const sub = "anon:7f3a1b2c3d4e";
    expect(isGuestSub(sub)).toBe(true);
    expect(authorLabel(sub, "Guest", "Unnamed member")).toBe("Guest 7f3a");
    expect(authorLabel(sub, "ゲスト", "Unnamed member")).toBe("ゲスト 7f3a");
  });

  it("uses the email local-part for a member email sub", () => {
    expect(isGuestSub("alice@example.com")).toBe(false);
    expect(authorLabel("alice@example.com", "Guest", "Unnamed member")).toBe("alice");
  });

  // #859 (review rejection): this case used to assert the DEFECT — "falls back to the raw sub". A member
  // the product cannot name now reads the way the member table already read, so the same person is
  // named the same on their comments, in the revision list and in the notification feed.
  it("names a member it cannot name the way every other surface does — never the raw id", () => {
    const sub = "wlocal_11111111-2222-3333-4444-555555555555"; // what a password invite mints
    const label = authorLabel(sub, "Guest", "Unnamed member");
    expect(label).toBe(memberLabel(sub, null, "Unnamed member"));
    expect(label).not.toContain(sub);
    expect(label).toContain("Unnamed member");
  });

  it("keeps the short id, so two unnamed members are still distinguishable", () => {
    const a = authorLabel("wlocal_aaaaaaaa-0000-0000-0000-000000000000", "Guest", "Unnamed member");
    const b = authorLabel("wlocal_bbbbbbbb-0000-0000-0000-000000000000", "Guest", "Unnamed member");
    expect(a).not.toBe(b);
  });
});
