import { describe, it, expect } from "vitest";
import { uniformResizeSize } from "./table-edit";

// #154 — the uniform multi-select column/row resize. The bug it fixes: selecting several columns and
// dragging a boundary set every column to draggedWidth+delta, ballooning the block so the dragged
// edge shot far past the pointer. The correct rule: the n columns take a UNIFORM size and the block's
// dragged edge lands exactly on the pointer. These assert the geometry (distinct pass/fail), not just
// that a number comes back.
describe("uniformResizeSize (#154)", () => {
  const MIN = 40;
  const INF = Infinity;

  it("single column (n=1): the edge follows the pointer exactly", () => {
    // block starts at x=100; pointer at 260 → the one column is 160 wide (its right edge = 260).
    expect(uniformResizeSize(260, 100, 1, MIN, INF)).toBe(160);
  });

  it("multi-select (n=3): columns are EQUALISED and the dragged edge lands on the pointer", () => {
    // The #154 example: A/B/C selected (was 100/50/150, block from x=0), drag the right edge to x=540.
    // Each column becomes 540/3 = 180 (uniform); the block's right edge = blockStart + 3*180 = 540 = pointer.
    const per = uniformResizeSize(540, 0, 3, MIN, INF);
    expect(per).toBe(180);
    expect(0 + 3 * per).toBe(540); // dragged edge tracks the pointer (was ~780 with the old balloon bug)
  });

  it("accounts for a non-zero block start (only the SELECTED block resizes)", () => {
    // block of 2 columns starting at x=120, pointer at 320 → per = (320-120)/2 = 100; right edge = 320.
    const per = uniformResizeSize(320, 120, 2, MIN, INF);
    expect(per).toBe(100);
    expect(120 + 2 * per).toBe(320);
  });

  it("clamps each column to the minimum width when dragged too far left", () => {
    expect(uniformResizeSize(50, 0, 3, MIN, INF)).toBe(MIN); // (50/3≈17) → floored to the 40 min
  });

  it("caps the block total to maxBlock so the table cannot overflow the visible width (#5)", () => {
    // maxBlock = 300 across 3 columns → each capped at floor(300/3)=100 even though the pointer wants more.
    expect(uniformResizeSize(900, 0, 3, MIN, 300)).toBe(100);
  });
});
