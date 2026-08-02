// #596: shared toast feedback for revoke/unassign mutations. The server now answers honestly —
// 200 + `stillCovered` when the row went but another assignment keeps granting the capability,
// 409 `still_covered` when nothing would change at all — and every surface that removes access
// must SAY both instead of a success toast that implies the person lost access. One helper so
// the four surfaces (page dialog, space members, tenant members, group roles) cannot drift.
import type { RevokeOutcome } from "../data/queries";
import { ApiError } from "../data/apiClient";
import { notify } from "../ui/toast";

type T = (key: string, options?: Record<string, unknown>) => string;

const viaLabel = (vias: string[]): string => [...new Set(vias)].join(", ");

// Success side: plain success when the access really went; info naming the coverage when it did not.
export function notifyRevokeOutcome(t: T, data: RevokeOutcome | null | undefined): void {
  const covered = data?.stillCovered ?? [];
  if (covered.length > 0) {
    notify.info(t("toast.accessRevokedStillCovered", { via: viaLabel(covered.map((c) => c.via)) }));
  } else {
    notify.success(t("toast.accessRevoked"));
  }
}

// Error side: the honest 409 gets its specific message (naming what to remove instead); anything
// else stays the generic failure.
export function notifyRevokeError(t: T, err: unknown): void {
  if (err instanceof ApiError && err.code === "still_covered") {
    notify.error(t("toast.accessRevokeCovered", { via: viaLabel(err.coveredBy ?? []) }));
  } else {
    notify.error(t("toast.actionFailed"));
  }
}
