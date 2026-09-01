// #978 (owner ruling 2026-09-02): the persistent not-live toast is WARNING-typed. The band it replaced
// carried the danger accent; the first toast version was normal-typed and read as an ordinary notice —
// the design review called the missing type out (②) and the owner ruled to tint it.
// The Toaster mounts with richColors, so the type is what carries the color.
import { describe, it, expect, vi, beforeEach } from "vitest";

const warning = vi.fn();
const plain = Object.assign(vi.fn(), {
  warning: (...a: unknown[]) => warning(...a),
  success: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
});
vi.mock("sonner", () => ({ toast: plain, Toaster: () => null }));
vi.mock("../components/ui/sonner", () => ({ Toaster: () => null }));

const { notify } = await import("./toast");

beforeEach(() => { warning.mockClear(); plain.mockClear(); });

describe("#978 the persistent toast is warning-typed and keeps its persistence contract", () => {
  it("persistent() goes through toast.warning with the same id/duration/description contract", () => {
    notify.persistent("notlive:x", "title", "desc");
    expect(warning).toHaveBeenCalledExactlyOnceWith("title", { id: "notlive:x", duration: Infinity, description: "desc" });
    // ⚠️ and NOT through the untyped toast() — that is the exact regression this pins.
    expect(plain).not.toHaveBeenCalled();
  });

  it("the same id is passed through, so a reason change still replaces rather than stacks", () => {
    notify.persistent("same", "one", "a");
    notify.persistent("same", "two", "b");
    const ids = warning.mock.calls.map((c) => (c[1] as { id: string }).id);
    expect(ids).toEqual(["same", "same"]);
  });
});
