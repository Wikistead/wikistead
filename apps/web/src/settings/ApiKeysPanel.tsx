import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
import { useCreateApiKey, useRevokeApiKey, type ApiScope, type ApiKeySummary, type ApiKeyCreated } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { relTime } from "../ui/relative-time";

// #461: when a key was last authenticated with — the signal that tells you which keys are dead
// weight and safe to revoke. The server has always returned lastUsedAt (and #428 made the write
// actually land under RLS); only the list never showed it. Relative, with the exact time on hover;
// "never used" is a distinct state, not a blank.
function LastUsed({ at }: { at: string | null }) {
  const { t, i18n } = useTranslation();
  if (!at) {
    return <span className="flex-none text-xs text-fg-dim" data-testid="api-key-last-used" data-used="never">{t("adminApi.neverUsed")}</span>;
  }
  const { rel, abs } = relTime(at, i18n.language);
  return (
    <time className="flex-none text-xs text-fg-dim" dateTime={at} title={`${t("adminApi.lastUsed")}: ${abs}`} data-testid="api-key-last-used" data-used="yes">
      {t("adminApi.lastUsedRel", { rel })}
    </time>
  );
}

// #462: the key list and the create form, shared by the two surfaces that show them — the admin
// console (every key in the tenant) and a member's own settings (their keys). Same affordances, two
// audiences; the difference is only which list is handed in and whether issuing is allowed here.
// `canIssue` hides the form when the tenant has restricted issuing to admins — the SERVER refuses
// regardless, this only avoids offering something that will be turned down.
export function ApiKeysPanel({
  keys, canIssue, maxScope, emptyText,
}: {
  keys: ApiKeySummary[];
  canIssue: boolean;
  maxScope: ApiScope;
  emptyText?: string;
}) {
  const { t } = useTranslation();
  const create = useCreateApiKey();
  const revoke = useRevokeApiKey();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiScope>("read");
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);

  // Under a read cap, write isn't offerable.
  const scopeOptions = (maxScope === "read" ? (["read"] as ApiScope[]) : (["read", "write"] as ApiScope[]))
    .map((s) => ({ value: s, label: t(`adminApi.scope_${s}`) }));
  const effScope: ApiScope = maxScope === "read" ? "read" : scope;

  const onCreate = () => {
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), scope: effScope }, {
      onSuccess: (k) => { setCreated(k); setName(""); notify.success(t("toast.saved")); },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  return (
    <>
      {canIssue && (
        <>
          <label className="mb-1.5 mt-[18px] block text-sm text-fg-dim">{t("adminApi.createTitle")}</label>
          <div className="flex items-center gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("adminApi.namePlaceholder")} aria-label={t("adminApi.name")} data-testid="api-key-name" />
            <Select value={effScope} onChange={(v) => setScope(v as ApiScope)} ariaLabel={t("adminApi.scope")} testId="api-key-scope" size="sm" options={scopeOptions} />
            <Button variant="primary" size="sm" disabled={!name.trim() || create.isPending} onClick={onCreate} data-testid="api-key-create">{t("adminApi.create")}</Button>
          </div>
        </>
      )}

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
        {keys.map((k) => (
          <div key={k.id} className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2" data-testid="api-key-item">
            <span className="min-w-[48px] flex-none rounded-full border border-border px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-fg-dim data-[scope=write]:border-[var(--accent)] data-[scope=write]:text-[var(--accent)]" data-scope={k.scope}>{t(`adminApi.scope_${k.scope}`)}</span>
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{k.name}</span>
            <code className="flex-none font-mono text-xs text-fg-dim">{k.keyPrefix}…</code>
            <LastUsed at={k.lastUsedAt} />
            <IconButton aria-label={t("adminApi.revoke")} data-testid="api-key-revoke" className="hover:text-destructive"
              onClick={() => revoke.mutate(k.id, { onSuccess: () => notify.success(t("toast.linkRevoked")), onError: () => notify.error(t("toast.actionFailed")) })}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
        {keys.length === 0 && <p className="text-xs text-fg-dim">{emptyText ?? t("adminApi.empty")}</p>}
      </div>
    </>
  );
}
