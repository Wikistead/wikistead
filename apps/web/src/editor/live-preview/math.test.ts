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

  // #141 bounce (comment 624): the reviewer's EXACT device examples — the real render path (findMath →
  // mathField, used by both the edit and published surfaces) must reject all of these.
  it("does NOT math-ify the reported currency examples (real path)", () => {
    expect(math("$5 and $6")).toHaveLength(0);
    expect(math("$10 for $20")).toHaveLength(0);
    expect(math("cost $5 and $6 today")).toHaveLength(0);
    // full Pandoc rule (3): a closing $ that runs into a digit isn't a delimiter
    expect(math("$5 and$6")).toHaveLength(0);
    expect(math("$100$200")).toHaveLength(0);
    // ...but a REAL formula amid currency still renders
    const m = math("a $5 and $6 b $x$");
    expect(m).toHaveLength(1);
    expect(m[0]!.tex).toBe("x");
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

// #141/#183: display-math atoms must be fed to blockEntry's vertical-motion correction via the
// motionAtomProvider facet (they live in mathField, separate from livePreview.blocks). Verify the
// wiring: a state with mathField exposes the $$…$$ block through the facet so j/k step over it.
import { mathField } from "./math";
import { motionAtomProvider } from "./decorations";

describe("motionAtomProvider wiring (#141/#183 display-math motion)", () => {
  it("mathField contributes the $$…$$ block range to the motion-atom facet", () => {
    const doc = "before\n$$\n\\int_0^1 x\\,dx\n$$\nafter";
    const state = EditorState.create({ doc, extensions: [mathField] });
    const providers = state.facet(motionAtomProvider);
    expect(providers.length).toBeGreaterThan(0);
    const ranges = providers.flatMap((p) => p(state));
    // exactly one display-math atom, and it spans the whole $$…$$ block (not just one line, and not
    // extending past the closing $$).
    expect(ranges).toHaveLength(1);
    const openAt = doc.indexOf("$$");
    const closeEnd = doc.lastIndexOf("$$") + 2;
    expect(ranges[0]!.from).toBe(openAt);
    expect(ranges[0]!.to).toBe(closeEnd);
  });

  it("contributes NO atom for inline $…$ (only $$ display blocks are motion atoms)", () => {
    const state = EditorState.create({ doc: "energy is $x^2$ here", extensions: [mathField] });
    const ranges = state.facet(motionAtomProvider).flatMap((p) => p(state));
    expect(ranges).toHaveLength(0); // inline math is single-line; it must not become a block-motion atom
  });
});
