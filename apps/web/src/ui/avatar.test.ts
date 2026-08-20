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
  it("#288: any non-ASCII name yields ONE stable-width glyph (no mixed half+full-width)", () => {
    expect(initials("246 被リンク警告の確認")).toBe("被"); // digit-led → first meaningful CJK glyph, not the digit
    expect(initials("被リンク")).toBe("被");
    expect(initials("A被リンク")).toBe("A"); // a leading ASCII letter is meaningful on its own
    expect(initials("🎉 party")).toBe("🎉"); // emoji-led → the emoji
    expect(Array.from(initials("42 テスト")).length).toBe(1); // always a single grapheme
  });
  it("empty / whitespace → '?'", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });
});
