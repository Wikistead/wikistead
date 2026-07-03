import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import { findMath } from "./math";

// #141 (approved judgment ②): the $ delimiter follows the Pandoc/CommonMark-math rule so prose with
// currency is NOT math-ified — the opening $ must be followed by a non-whitespace char and the closing
// $ preceded by one. (findMath's inCode check needs the markdown tree, absent here → treated as
// non-code, which is exactly what we want to exercise for the delimiter rule.)
const math = (doc: string) => findMath(EditorState.create({ doc }));

describe("math delimiter rule (#141 judgment ②)", () => {
  it("renders real inline math", () => {
    const m = math("energy is $x^2$ here");
    expect(m.length).toBe(1);
    expect(m[0]!.tex).toBe("x^2");
    expect(m[0]!.display).toBe(false);
  });

  it("does NOT math-ify currency prose '$5 and $6' (closing $ preceded by whitespace)", () => {
    expect(math("it costs $5 and $6 total")).toHaveLength(0);
  });

  it("does NOT open on '$ x$' (opening $ followed by whitespace)", () => {
    expect(math("a $ x$ b")).toHaveLength(0);
  });

  it("renders block $$…$$ display math", () => {
    const m = math("$$\\int_0^1 x\\,dx$$");
    expect(m.length).toBe(1);
    expect(m[0]!.display).toBe(true);
  });

  it("ignores an escaped \\$ delimiter", () => {
    expect(math("price \\$5 to \\$9")).toHaveLength(0);
  });

  it("a lone $ (no valid close) is not math", () => {
    expect(math("just $5 here")).toHaveLength(0);
  });
});
