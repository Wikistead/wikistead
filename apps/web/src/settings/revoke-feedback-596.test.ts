// #596: the four surfaces that remove access must not tell the manager the access is gone when it is
// not. The server answers honestly (200 + `stillCovered` when a row went but another assignment keeps
// granting; 409 `still_covered` when the call would change nothing at all) — the toast has to carry
// that distinction, or the fix stops at the API and the screen keeps lying.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { notifyRevokeOutcome, notifyRevokeError } from "./revoke-feedback";
import { ApiError } from "../data/apiClient";
import { notify } from "../ui/toast";

vi.mock("../ui/toast", () => ({ notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// the real i18n interpolation is `{{via}}`; a stub that echoes key + via is enough to pin WHICH
// message was chosen and that the covering assignment's name reaches it.
const t = (key: string, opts?: Record<string, unknown>) => (opts?.via ? `${key}:${opts.via}` : key);

beforeEach(() => vi.clearAllMocks());

describe("#596: revoke feedback tells the truth about what happened", () => {
  it("a removal that really took the access away is a plain success", () => {
    notifyRevokeOutcome(t, { removed: true, stillCovered: [] });
    expect(notify.success).toHaveBeenCalledWith("toast.accessRevoked");
    expect(notify.info).not.toHaveBeenCalled();
  });

  it("a removal whose capability is still covered says so, and names the coverer", () => {
    notifyRevokeOutcome(t, { removed: true, stillCovered: [{ capability: "view", via: "kakunin-582" }] });
    expect(notify.info).toHaveBeenCalledWith("toast.accessRevokedStillCovered:kakunin-582");
    // the plain success toast is exactly what made this defect invisible
    expect(notify.success).not.toHaveBeenCalled();
  });

  it("several covering assignments are listed once each", () => {
    notifyRevokeOutcome(t, {
      removed: true,
      stillCovered: [{ capability: "view", via: "roleA" }, { capability: "comment", via: "roleA" }, { capability: "edit", via: "roleB" }],
    });
    expect(notify.info).toHaveBeenCalledWith("toast.accessRevokedStillCovered:roleA, roleB");
  });

  it("the 409 refusal gets its own message naming what to remove instead", () => {
    const err = new ApiError(409, "/pages/p/access", "still granted by another assignment");
    err.code = "still_covered";
    err.coveredBy = ["kakunin-582"];
    notifyRevokeError(t, err);
    expect(notify.error).toHaveBeenCalledWith("toast.accessRevokeCovered:kakunin-582");
  });

  it("any other failure stays the generic one (a 403 is not a coverage explanation)", () => {
    notifyRevokeError(t, new ApiError(403, "/pages/p/access", "forbidden"));
    expect(notify.error).toHaveBeenCalledWith("toast.actionFailed");
  });

  it("a missing body (204-shaped legacy response) does not crash and reads as a plain success", () => {
    notifyRevokeOutcome(t, null);
    expect(notify.success).toHaveBeenCalledWith("toast.accessRevoked");
  });

  // review F5: a coverer is named as a ROLE. The raw wire capability is not a name any of these
  // screens shows (#582 removed exactly that), so a built-in coverer wears its noun.
  it("a built-in coverer is named by its noun, not its wire capability", () => {
    notifyRevokeOutcome(t, { removed: true, stillCovered: [{ capability: "view", via: "view" }] });
    expect(notify.info).toHaveBeenCalledWith("toast.accessRevokedStillCovered:viewer");
  });

  // review F1: the server omits `via` for a caller who may not read role definitions on the resource.
  // The fact still has to reach them — without inventing a name.
  it("coverage with no name still says the access remains", () => {
    notifyRevokeOutcome(t, { removed: true, stillCovered: [{ capability: "view" }] });
    expect(notify.info).toHaveBeenCalledWith("toast.accessRevokedStillCoveredUnnamed");
    expect(notify.success).not.toHaveBeenCalled();
  });

  it("a 409 with no names refuses in words that do not name anything", () => {
    const err = new ApiError(409, "/pages/p/access", "still granted by another assignment");
    err.code = "still_covered";
    err.coveredBy = [];
    notifyRevokeError(t, err);
    expect(notify.error).toHaveBeenCalledWith("toast.accessRevokeCoveredUnnamed");
  });
});
