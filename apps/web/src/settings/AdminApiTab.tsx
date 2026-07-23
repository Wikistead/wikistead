import { useTranslation } from "react-i18next";
import { useApiKeys, useApiPolicy, useUpdateApiPolicy, type ApiScope } from "../data/queries";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { ApiKeysPanel } from "./ApiKeysPanel";

const label = "mb-1.5 mt-[18px] block text-sm text-fg-dim";

// API keys (Phase 5f), the ADMIN view: every key in the tenant plus the two tenant policies — who
// may issue (#462) and the ceiling on what scope they may issue with. A member manages their own
// keys in their account settings; this list exists so an admin can see what is out there.
export function AdminApiTab() {
  const { t } = useTranslation();
  const keys = useApiKeys();
  const policy = useApiPolicy();
  const updatePolicy = useUpdateApiPolicy();

  const cap: ApiScope = policy.data?.maxScope ?? "write";
  const issuePolicy = policy.data?.issuePolicy ?? "members";
  const saved = { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) };

  return (
    <div className="max-w-[640px] p-6" data-testid="admin-api">
      <h2 className="mt-0">{t("adminApi.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("adminApi.body")}</p>

      {/* #462: who may issue at all. The server enforces this; the member surface only hides its
          own form when the answer is no. */}
      <label className={label}>{t("adminApi.issuePolicy")}</label>
      <Select
        value={issuePolicy}
        onChange={(v) => updatePolicy.mutate({ issuePolicy: v as "members" | "admins_only" }, saved)}
        ariaLabel={t("adminApi.issuePolicy")}
        testId="api-issue-policy"
        size="sm"
        options={[
          { value: "members", label: t("adminApi.issueMembers") },
          { value: "admins_only", label: t("adminApi.issueAdminsOnly") },
        ]}
      />
      <p className="mt-1.5 text-xs text-fg-dim">{t(issuePolicy === "members" ? "adminApi.issueMembersHint" : "adminApi.issueAdminsOnlyHint")}</p>

      <label className={label}>{t("adminApi.policy")}</label>
      <Select
        value={cap}
        onChange={(v) => updatePolicy.mutate({ maxScope: v as ApiScope }, saved)}
        ariaLabel={t("adminApi.policy")}
        testId="api-policy"
        size="sm"
        options={[{ value: "write", label: t("adminApi.policyWrite") }, { value: "read", label: t("adminApi.policyRead") }]}
      />

      <ApiKeysPanel keys={keys.data ?? []} canIssue maxScope={cap} admin />
    </div>
  );
}
