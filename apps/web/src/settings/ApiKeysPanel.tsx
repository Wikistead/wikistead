import { useEffect, useState } from "react";
import { ListRow, ListBox } from "../ui/list-rows";
import { expiryChoices, defaultExpiry } from "./key-expiry-choices";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
import { useCreateApiKey, useCreateNarrowedApiKey, useRevokeApiKey, useAdminRevokeApiKey, useSpaces, type ApiScope, type ApiKeySummary, type ApiKeyCreated } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { ConfirmDialog } from "../ui/dialogs"; // #504: revoking a key is irreversible — confirm first
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { relTime } from "../ui/relative-time";

// #637: the verbs a narrowed key may carry. The EE route table is the authority and the server checks
// against it; this mirrors it for the picker, and the pin below asserts the two agree rather than
// trusting that somebody remembered to update both.
const NARROW_CAPS = ["view", "edit", "publish", "delete", "comment", "manage"] as const;

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
  // #637 / ADR-216: narrowing. Off by default and opened deliberately — an unnarrowed key is the common
  // case and the one the form should stay simple for. Spaces are a FLAT list: ADR-215 declined per-page
  // narrowing precisely because a page picker means handling a tree, and a space picker does not.
  const narrowedCreate = useCreateNarrowedApiKey();
  const spacesQ = useSpaces();
  const [narrowing, setNarrowing] = useState(false);
  const [pickedSpaces, setPickedSpaces] = useState<string[]>([]);
  const [pickedCaps, setPickedCaps] = useState<string[]>([]);
  // #504: a revoked key never authenticates again (the member issues a new one) — confirm, by name.
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);

  // Under a read cap, write isn't offerable.
  const scopeOptions = (maxScope === "read" ? (["read"] as ApiScope[]) : (["read", "write"] as ApiScope[]))
    .map((s) => ({ value: s, label: t(`adminApi.scope_${s}`) }));
  const effScope: ApiScope = maxScope === "read" ? "read" : scope;
  // #628the choices are DERIVED from the ceiling, not a fixed ladder filtered by it. Filtering
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
    const done = (k: ApiKeyCreated | null) => {
      if (!k) return;
      setCreated(k); setName(""); setExpiry(defaultExpiry(maxAgeDays));
      setPickedSpaces([]); setPickedCaps([]); setNarrowing(false);
      notify.success(t("toast.saved"));
    };
    const base = { name: name.trim(), scope: effScope, expiresInDays: expiry === "" ? null : Number(expiry) };
    // #637: the narrowed route is a DIFFERENT one, because narrowing is EE. On a deployment without the
    // overlay it is simply not there, and a 404 is the honest answer — better than a form that appears to
    // confine a key and hands back one that reaches everything.
    if (narrowing && (pickedSpaces.length > 0 || pickedCaps.length > 0)) {
      narrowedCreate.mutate({
        ...base,
        ...(pickedSpaces.length > 0 ? { spaces: pickedSpaces } : {}),
        ...(pickedCaps.length > 0 ? { capabilities: pickedCaps } : {}),
      }, { onSuccess: done, onError: () => notify.error(t("toast.actionFailed")) });
      return;
    }
    create.mutate(base, { onSuccess: done, onError: () => notify.error(t("toast.actionFailed")) });
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

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
            <Button variant="primary" disabled={!name.trim() || create.isPending || narrowedCreate.isPending} onClick={onCreate} data-testid="api-key-create">{t("adminApi.create")}</Button>
          </FormRow>
          {/* #637 / ADR-216: what the key may REACH, beside how long it lives and whether it may write.
              Collapsed by default: most keys are not narrowed, and a form that asks every question at once
              makes the common case harder to answer. */}
          <Button variant="ghost" size="sm" className="mt-1" data-testid="api-key-narrow-toggle"
            onClick={() => setNarrowing((v) => !v)}>
            {narrowing ? t("adminApi.narrowHide") : t("adminApi.narrowShow")}
          </Button>
          {narrowing && (
            <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3" data-testid="api-key-narrow">
              <p className="text-xs text-fg-dim">{t("adminApi.narrowHint")}</p>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-fg-dim">{t("adminApi.narrowSpaces")}</span>
                <ListBox className="flex flex-col gap-1" data-testid="api-key-space-list">
                  {(spacesQ.data ?? []).map((sp) => (
                    <label key={sp.id} className="flex items-center gap-2 text-sm" data-testid="api-key-space-option">
                      <input type="checkbox" checked={pickedSpaces.includes(sp.id)}
                        onChange={() => toggle(pickedSpaces, setPickedSpaces, sp.id)}
                        data-testid={`api-key-space-${sp.id}`} />
                      <span className="min-w-0 truncate">{sp.name}</span>
                    </label>
                  ))}
                </ListBox>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-fg-dim">{t("adminApi.narrowCaps")}</span>
                {/* The verbs the route table actually offers. The server validates against the same set,
                    so a list invented here would go stale the day a verb is added there. */}
                <div className="flex flex-wrap gap-2">
                  {NARROW_CAPS.map((c) => (
                    <label key={c} className="flex items-center gap-1 text-sm" data-testid="api-key-cap-option">
                      <input type="checkbox" checked={pickedCaps.includes(c)}
                        onChange={() => toggle(pickedCaps, setPickedCaps, c)} data-testid={`api-key-cap-${c}`} />
                      <span>{t(`roleCaps.${c}`, c)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* #638: the box this invented is now shared — the invite and password-setup links were the two
          that had neither the warning nor the copy button, and they are the ones that strand people. */}
      {created && <OneTimeSecret value={created.plaintext} testId="api-key-plaintext" />}

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
