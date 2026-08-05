import { useEffect, useState } from "react";
import { ListRow, ListBox } from "../ui/list-rows";
import { expiryChoices, defaultExpiry } from "./key-expiry-choices";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
import { useCreateApiKey, useRevokeApiKey, useAdminRevokeApiKey, type ApiScope, type ApiKeySummary, type ApiKeyCreated } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { ConfirmDialog } from "../ui/dialogs"; // #504: revoking a key is irreversible — confirm first
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
    <time className="flex-none text-xs text-fg-dim" dateTime={at} data-tip={`${t("adminApi.lastUsed")}: ${abs}`} data-testid="api-key-last-used" data-used="yes">
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
  keys, canIssue, maxScope, maxAgeDays, emptyText, admin = false,
}: {
  keys: ApiKeySummary[];
  canIssue: boolean;
  maxScope: ApiScope;
  // #628 / ADR-215 §1: the tenant's ceiling on key lifetime, or null for none.
  maxAgeDays?: number | null;
  emptyText?: string;
  // #495 / ADR-182: the ADMIN console passes admin — it shows the OWNER of each key and revokes via
  // the admin-gated route (kill any member's key). The member self-view leaves it false (owner-only).
  admin?: boolean;
}) {
  const { t } = useTranslation();
  const create = useCreateApiKey();
  const revokeOwn = useRevokeApiKey();
  const revokeAdmin = useAdminRevokeApiKey();
  const revoke = admin ? revokeAdmin : revokeOwn;
  const [name, setName] = useState("");
  const [scope, setScope] = useState<ApiScope>("read");
  // #628: how long the key should live. "" = no expiry, which the server refuses when the tenant has a
  // ceiling — the choice is offered rather than pre-decided, so somebody who wants a permanent key on a
  // tenant that forbids them is told, instead of quietly getting a short one.
  // Starts on the longest lifetime the tenant permits, which is always a value that EXISTS in the list.
  // A Select whose value matches no option renders as a bare chevron with no width (#603).
  const [expiry, setExpiry] = useState<string>(() => defaultExpiry(maxAgeDays));
  const [created, setCreated] = useState<ApiKeyCreated | null>(null);
  // #504: a revoked key never authenticates again (the member issues a new one) — confirm, by name.
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  // Under a read cap, write isn't offerable.
  const scopeOptions = (maxScope === "read" ? (["read"] as ApiScope[]) : (["read", "write"] as ApiScope[]))
    .map((s) => ({ value: s, label: t(`adminApi.scope_${s}`) }));
  const effScope: ApiScope = maxScope === "read" ? "read" : scope;
  // #628 the choices are DERIVED from the ceiling, not a fixed ladder filtered by it. Filtering
  // left a 3-day policy with nothing to offer, so the form refused what the API would have granted —
  // see `key-expiry-choices`.
  const expiryOptions = expiryChoices(maxAgeDays).map((c) => ({
    value: c.value,
    label: c.days === null ? t("adminApi.expiryNever") : t("adminApi.expiryDays", { count: c.days }),
  }));
  // The ceiling arrives from a query, so the first render has none and the choices change under the
  // control. If what is selected stops existing, fall back to the default rather than leaving a Select
  // pointing at nothing — that is the blank-chevron state again, just reached a moment later.
  useEffect(() => {
    if (!expiryOptions.some((o) => o.value === expiry)) setExpiry(defaultExpiry(maxAgeDays));
  }, [maxAgeDays]);

  const onCreate = () => {
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), scope: effScope, expiresInDays: expiry === "" ? null : Number(expiry) }, {
      onSuccess: (k) => { setCreated(k); setName(""); setExpiry(defaultExpiry(maxAgeDays)); notify.success(t("toast.saved")); },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  return (
    <>
      {canIssue && (
        <>
          <label className="mb-1.5 mt-[18px] block text-sm text-fg-dim">{t("adminApi.createTitle")}</label>
          {/* #535: the row carries the scale, so no control here states its own. */}
          <FormRow>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("adminApi.namePlaceholder")} aria-label={t("adminApi.name")} data-testid="api-key-name" />
            <Select value={effScope} onChange={(v) => setScope(v as ApiScope)} ariaLabel={t("adminApi.scope")} testId="api-key-scope" options={scopeOptions} />
            <Select value={expiry} onChange={setExpiry} ariaLabel={t("adminApi.expiry")} testId="api-key-expiry" options={expiryOptions} />
            <Button variant="primary" disabled={!name.trim() || create.isPending} onClick={onCreate} data-testid="api-key-create">{t("adminApi.create")}</Button>
          </FormRow>
        </>
      )}

      {created && (
        <div className="my-3.5 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] px-3 py-2.5" data-testid="api-key-plaintext">
          <p className="text-xs text-fg-dim">{t("adminApi.copyOnce")}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs [overflow-wrap:anywhere]">{created.plaintext}</code>
            <IconButton aria-label={t("adminApi.copy")} data-tip={t("adminApi.copy")} onClick={() => { navigator.clipboard?.writeText(created.plaintext); notify.success(t("toast.copied")); }}>
              <Copy size={14} />
            </IconButton>
          </div>
        </div>
      )}

      <ListBox className="mt-5" data-testid="api-key-list">
        {keys.map((k) => (
          <ListRow key={k.id} data-testid="api-key-item">
            <span className="min-w-[48px] flex-none rounded-full border border-border px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-fg-dim data-[scope=write]:border-[var(--accent)] data-[scope=write]:text-[var(--accent)]" data-scope={k.scope}>{t(`adminApi.scope_${k.scope}`)}</span>
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{k.name}</span>
            {/* #495: the admin view names WHO owns the key (name, or the sub when the name is null) */}
            {admin && <span className="flex-none max-w-[9rem] truncate text-xs text-fg-dim" data-testid="api-key-owner" data-tip={k.ownerName ?? k.ownerUserId}>{k.ownerName ?? k.ownerUserId}</span>}
            <code className="flex-none font-mono text-xs text-fg-dim">{k.keyPrefix}…</code>
            <LastUsed at={k.lastUsedAt} />
            {/* #504: red at rest (hover-only red is against the policy) + confirm before the kill. */}
            <IconButton aria-label={t("adminApi.revoke")} data-testid="api-key-revoke" variant="danger"
              onClick={() => setRevoking({ id: k.id, name: k.name })}>
              <Trash2 size={14} />
            </IconButton>
          </ListRow>
        ))}
        {keys.length === 0 && <p className="text-xs text-fg-dim">{emptyText ?? t("adminApi.empty")}</p>}
      </ListBox>
      {/* #504: the revoke confirm — names the key, danger tone. */}
      <ConfirmDialog
        open={revoking !== null}
        message={revoking ? t("adminApi.revokeConfirm", { name: revoking.name }) : ""}
        confirmTestId="api-key-revoke-confirm"
        confirmLabel={t("adminApi.revoke")}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking) revoke.mutate(revoking.id, { onSuccess: () => notify.success(t("toast.linkRevoked")), onError: () => notify.error(t("toast.actionFailed")) });
          setRevoking(null);
        }}
      />
    </>
  );
}
