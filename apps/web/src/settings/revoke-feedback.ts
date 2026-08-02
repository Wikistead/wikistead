// #596: shared toast feedback for revoke/unassign mutations. The server now answers honestly —
// 200 + `stillCovered` when the row went but another assignment keeps granting the capability,
// 409 `still_covered` when nothing would change at all — and every surface that removes access
// must SAY both instead of a success toast that implies the person lost access. One helper so
// the four surfaces (page dialog, space members, tenant members, group roles) cannot drift.
import type { RevokeOutcome } from "../data/queries";
import { ApiError } from "../data/apiClient";
import { capNoun } from "./role-nouns";
import { notify } from "../ui/toast";

type T = (key: string, options?: Record<string, unknown>) => string;

// #596 review F5: a coverer is a ROLE — a custom role's name, or the noun a built-in grant is called.
// The raw wire capability ("view", "edit") is not a name anyone on these screens is shown (#582), and
// printing it here re-introduced exactly what that ticket removed.
const viaLabel = (vias: (string | undefined)[]): string =>
  [...new Set(vias.filter((v): v is string => !!v).map(capNoun))].join(", ");

// Success side: plain success when the access really went; a neutral notice naming the coverage when
// it did not. The server omits the NAME for a caller who may not read role definitions on this
// resource (review F1) — then the notice says the same thing without naming it.
export function notifyRevokeOutcome(t: T, data: RevokeOutcome | null | undefined): void {
  const covered = data?.stillCovered ?? [];
  if (covered.length === 0) {
    notify.success(t("toast.accessRevoked"));
    return;
  }
  const via = viaLabel(covered.map((c) => c.via));
  notify.info(via ? t("toast.accessRevokedStillCovered", { via }) : t("toast.accessRevokedStillCoveredUnnamed"));
}

// Error side: the honest 409 gets its specific message (naming what to remove instead); anything
// else stays the generic failure.
export function notifyRevokeError(t: T, err: unknown): void {
  if (err instanceof ApiError && err.code === "still_covered") {
    const via = viaLabel(err.coveredBy ?? []);
    notify.error(via ? t("toast.accessRevokeCovered", { via }) : t("toast.accessRevokeCoveredUnnamed"));
    return;
  }
  notify.error(t("toast.actionFailed"));
}
