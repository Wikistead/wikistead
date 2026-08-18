import { useTranslation } from "react-i18next";
import { useApiKeys, useApiPolicy, useUpdateApiPolicy, type ApiScope } from "../data/queries";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { ApiKeysPanel } from "./ApiKeysPanel";
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading

const label = "mb-1.5 mt-[18px] block text-sm text-fg-dim";

// API keys (Phase 5f), the ADMIN view: every key in the tenant plus the ceiling on what scope they may
// be issued with. A member manages their own keys in their account settings; this list exists so an admin
// can see what is out there.
// #496 / ADR-181: the "who may issue" selector USED to live here as a two-choice policy (#462). That
// authority is now the `issueApiKeys` tenant role capability, configured in ONE place — the Roles tab —
// alongside every other capability (the member toggle for "all members", a custom tenant role for
// specific people). Keeping a second control here would be the two-sources-of-truth the ADR retires.
export function AdminApiTab() {
  const { t } = useTranslation();
  const keys = useApiKeys();
  const policy = useApiPolicy();
  const updatePolicy = useUpdateApiPolicy();

  const cap: ApiScope = policy.data?.maxScope ?? "write";
  const saved = { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) };

  return (
    <SettingsPane width="list" testId="admin-api" title={t("adminApi.title")} description={t("adminApi.body")}>

      <label className={label}>{t("adminApi.policy")}</label>
      <Select
        value={cap}
        onChange={(v) => updatePolicy.mutate({ maxScope: v as ApiScope }, saved)}
        ariaLabel={t("adminApi.policy")}
        testId="api-policy"
        size="sm"
        options={[{ value: "write", label: t("adminApi.policyWrite") }, { value: "read", label: t("adminApi.policyRead") }]}
      />

      <ApiKeysPanel keys={keys.data ?? []} canIssue maxScope={cap} maxAgeDays={policy.data?.maxAgeDays ?? null} admin />
    </SettingsPane>
  );
}
