import { describe, it, expect } from "vitest";
import { colorFromString, initials } from "./avatar";

describe("colorFromString", () => {
  it("is deterministic — same seed → same colour", () => {
    expect(colorFromString("user-42")).toBe(colorFromString("user-42"));
  });
  it("spreads distinct seeds across hues (no trivial collision)", () => {
    expect(colorFromString("alice")).not.toBe(colorFromString("bob"));
  });
  it("always yields a parseable hsl() with readable lightness", () => {
    expect(colorFromString("anything")).toMatch(/^hsl\(\d{1,3} 58% 45%\)$/);
  });
  it("never throws on empty input", () => {
    expect(colorFromString("")).toMatch(/^hsl\(/);
  });
});

describe("initials", () => {
  it("two words → first letters of first and last, upper-cased", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("  jon  von  neumann ")).toBe("JN");
  });
  it("one word → first two chars upper-cased", () => {
    expect(initials("madonna")).toBe("MA");
  });
  it("CJK / emoji → a single leading grapheme (no upper-casing)", () => {
    expect(initials("山田太郎")).toBe("山");
  });
  it("empty / whitespace → '?'", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });
});
