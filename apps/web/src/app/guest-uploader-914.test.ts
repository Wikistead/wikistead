// #914: an edit-link guest has an image uploader that presigns by page; a view-link guest has none.
import { describe, it, expect, vi } from "vitest";

const calls: { path: string; init?: RequestInit }[] = [];
vi.mock("../data/apiClient", () => ({
  apiFetch: vi.fn(async (path: string, _bearer: unknown, init?: RequestInit) => {
    calls.push({ path, init });
    if (path.endsWith("/attachments/presign")) return { attachmentId: "att-1", uploadUrl: "https://store.test/put" };
    return {};
  }),
}));
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })));

const { guestImageUploader } = await import("./guest-uploader");

describe("#914 the guest image uploader", () => {
  it("is absent for a view link", () => {
    expect(guestImageUploader("view", "p1", () => "tok")).toBeUndefined();
  });

  it("presigns by page (no space id) and returns the attachment ref", async () => {
    const up = guestImageUploader("edit", "p1", () => "tok");
    expect(up).toBeDefined();
    const out = await up!(new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" }));
    expect(out).toEqual({ ref: "wks-attachment:att-1", alt: "shot.png" });
    expect(calls.map((c) => c.path)).toEqual(["/pages/p1/attachments/presign", "/attachments/att-1/confirm"]);
    // Break-check: hand the helper a space id and the first path becomes /spaces/…/presign — red.
  });
});
