import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
import {
  useApiKeys, useCreateApiKey, useRevokeApiKey, useApiPolicy, useUpdateApiPolicy,
  type ApiScope, type ApiKeyCreated,
} from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";

const label = "mb-1.5 mt-[18px] block text-sm text-fg-dim";

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
    <div className="max-w-[640px] p-6" data-testid="admin-api">
      <h2 className="mt-0">{t("adminApi.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("adminApi.body")}</p>

      <label className={label}>{t("adminApi.policy")}</label>
      <div className="flex items-center gap-2">
        <Select
          value={cap}
          onChange={(v) => updatePolicy.mutate(v as ApiScope, { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) })}
          ariaLabel={t("adminApi.policy")}
          testId="api-policy"
          size="sm"
          options={[{ value: "write", label: t("adminApi.policyWrite") }, { value: "read", label: t("adminApi.policyRead") }]}
        />
      </div>

      <label className={label}>{t("adminApi.createTitle")}</label>
      <div className="flex items-center gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("adminApi.namePlaceholder")} aria-label={t("adminApi.name")} data-testid="api-key-name" />
        <Select value={effScope} onChange={(v) => setScope(v as ApiScope)} ariaLabel={t("adminApi.scope")} testId="api-key-scope" size="sm" options={scopeOptions} />
        <Button variant="primary" size="sm" disabled={!name.trim() || create.isPending} onClick={onCreate} data-testid="api-key-create">{t("adminApi.create")}</Button>
      </div>

      {created && (
        <div className="my-3.5 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] px-3 py-2.5" data-testid="api-key-plaintext">
          <p className="text-xs text-fg-dim">{t("adminApi.copyOnce")}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs [overflow-wrap:anywhere]">{created.plaintext}</code>
            <IconButton aria-label={t("adminApi.copy")} title={t("adminApi.copy")} onClick={() => { navigator.clipboard?.writeText(created.plaintext); notify.success(t("toast.copied")); }}>
              <Copy size={14} />
            </IconButton>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-1" data-testid="api-key-list">
        {(keys.data ?? []).map((k) => (
          <div key={k.id} className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2" data-testid="api-key-item">
            <span className="min-w-[48px] flex-none rounded-full border border-border px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-fg-dim data-[scope=write]:border-[var(--accent)] data-[scope=write]:text-[var(--accent)]" data-scope={k.scope}>{t(`adminApi.scope_${k.scope}`)}</span>
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{k.name}</span>
            <code className="flex-none font-mono text-xs text-fg-dim">{k.keyPrefix}…</code>
            <IconButton aria-label={t("adminApi.revoke")} data-testid="api-key-revoke" className="hover:text-destructive"
              onClick={() => revoke.mutate(k.id, { onSuccess: () => notify.success(t("toast.linkRevoked")), onError: () => notify.error(t("toast.actionFailed")) })}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
        {(keys.data?.length ?? 0) === 0 && <p className="text-xs text-fg-dim">{t("adminApi.empty")}</p>}
      </div>
    </div>
  );
}
