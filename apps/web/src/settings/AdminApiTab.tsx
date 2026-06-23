import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
import {
  useApiKeys, useCreateApiKey, useRevokeApiKey, useApiPolicy, useUpdateApiPolicy,
  type ApiScope, type ApiKeyCreated,
} from "../data/queries";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import styles from "./AdminApiTab.module.css";

// API keys (Phase 5f). Per-member ownership (the list is the current user's keys);
// scope restricts a key below the owner's authority. The tenant policy (admin) caps
// the issuable scope. The plaintext is shown ONCE on creation.
export function AdminApiTab() {
  const { t } = useTranslation();
  const keys = useApiKeys();
  const policy = useApiPolicy();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const updatePolicy = useUpdateApiPolicy();

  const cap: ApiScope = policy.data?.maxScope ?? "write";
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiScope>("read");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  // Under a read cap, write isn't offerable.
  const scopeOptions = (cap === "read" ? (["read"] as ApiScope[]) : (["read", "write"] as ApiScope[]))
    .map((s) => ({ value: s, label: t(`adminApi.scope_${s}`) }));
  const effScope: ApiScope = cap === "read" ? "read" : scope;

  const onCreate = () => {
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), scope: effScope }, {
      onSuccess: (k) => { setCreated(k); setName(""); notify.success(t("toast.saved")); },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  return (
    <div className={styles.wrap} data-testid="admin-api">
      <h2 style={{ marginTop: 0 }}>{t("adminApi.title")}</h2>
      <p className={styles.body}>{t("adminApi.body")}</p>

      <label className={styles.label}>{t("adminApi.policy")}</label>
      <div className={styles.row}>
        <Select
          value={cap}
          onChange={(v) => updatePolicy.mutate(v as ApiScope, { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) })}
          ariaLabel={t("adminApi.policy")}
          testId="api-policy"
          size="sm"
          options={[{ value: "write", label: t("adminApi.policyWrite") }, { value: "read", label: t("adminApi.policyRead") }]}
        />
      </div>

      <label className={styles.label}>{t("adminApi.createTitle")}</label>
      <div className={styles.row}>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("adminApi.namePlaceholder")} aria-label={t("adminApi.name")} data-testid="api-key-name" />
        <Select value={effScope} onChange={(v) => setScope(v as ApiScope)} ariaLabel={t("adminApi.scope")} testId="api-key-scope" size="sm" options={scopeOptions} />
        <Button variant="primary" size="sm" disabled={!name.trim() || create.isPending} onClick={onCreate} data-testid="api-key-create">{t("adminApi.create")}</Button>
      </div>

      {created && (
        <div className={styles.created} data-testid="api-key-plaintext">
          <p className={styles.dim}>{t("adminApi.copyOnce")}</p>
          <div className={styles.plaintextRow}>
            <code className={styles.code}>{created.plaintext}</code>
            <button type="button" className={styles.iconBtn} title={t("adminApi.copy")} onClick={() => { navigator.clipboard?.writeText(created.plaintext); notify.success(t("toast.copied")); }}>
              <Copy size={14} />
            </button>
          </div>
        </div>
      )}

      <div className={styles.list} data-testid="api-key-list">
        {(keys.data ?? []).map((k) => (
          <div key={k.id} className={styles.item} data-testid="api-key-item">
            <span className={styles.cap} data-scope={k.scope}>{t(`adminApi.scope_${k.scope}`)}</span>
            <span className={styles.keyName}>{k.name}</span>
            <code className={styles.prefix}>{k.keyPrefix}…</code>
            <button type="button" className={styles.iconBtn} data-danger="" aria-label={t("adminApi.revoke")} data-testid="api-key-revoke"
              onClick={() => revoke.mutate(k.id, { onSuccess: () => notify.success(t("toast.linkRevoked")), onError: () => notify.error(t("toast.actionFailed")) })}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {(keys.data?.length ?? 0) === 0 && <p className={styles.dim}>{t("adminApi.empty")}</p>}
      </div>
    </div>
  );
}
