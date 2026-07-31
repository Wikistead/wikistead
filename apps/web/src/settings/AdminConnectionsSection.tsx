import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import {
  useAdminConnections, useCreateConnection, useUpdateConnection, useDeleteConnection, useReorderConnections,
  type AdminConnectionDTO,
} from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";

// #554 S4 / ADR-197 §1-3: N login connections, managed. The screen order IS the login-screen order
// (sort); the first row is the primary button. Presets (Google / Microsoft) prefill + brand and
// REFUSE a free label (rev3 — no admin string reaches the anonymous screen through a branded
// connection); a preset-less connection may carry a hygiene-checked label. Disable/delete of the
// last effective connection is refused by the server (409 login_lockout) — surfaced as a toast.
// Deleting is destructive and confirmed (#504): members the connection minted keep their rows, but
// their sign-in identities do NOT reconnect to a re-created connection (the §5 subject prefix
// derives from the connection id).
export function AdminConnectionsSection() {
  const { t } = useTranslation();
  const connections = useAdminConnections();
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const remove = useDeleteConnection();
  const reorder = useReorderConnections();
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState("");
  const [form, setForm] = useState({ issuer: "", clientId: "", clientSecret: "", redirectUri: "", label: "", entraTenantId: "" });
  const [flags, setFlags] = useState({ bootstrapEligible: false, trustGroups: false });
  const [deleting, setDeleting] = useState<AdminConnectionDTO | null>(null);

  const rows = connections.data ?? [];
  const onError = (e: unknown) => {
    // the server names the refusal (code login_lockout) — never sniff English message text
    notify.error((e as { code?: string })?.code === "login_lockout" ? t("adminConnections.lockoutRefused") : t("toast.actionFailed"));
  };
  const move = (idx: number, dir: -1 | 1) => {
    const ids = rows.map((r) => r.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
    reorder.mutate(ids, { onError });
  };
  const submit = () => {
    const base =
      preset === "google" ? { preset, clientId: form.clientId, clientSecret: form.clientSecret || undefined, redirectUri: form.redirectUri }
      : preset === "microsoft" ? { preset, clientId: form.clientId, clientSecret: form.clientSecret || undefined, redirectUri: form.redirectUri, entraTenantId: form.entraTenantId }
      : { issuer: form.issuer, clientId: form.clientId, clientSecret: form.clientSecret || undefined, redirectUri: form.redirectUri, label: form.label || undefined };
    // ADR-197 §2 rev2 / §6: the two TRUST flags are set where connections are created — explicit,
    // default off (S4 review F8: without this, UI-created connections could never carry them)
    const body = { ...base, bootstrapEligible: flags.bootstrapEligible, trustGroups: flags.trustGroups };
    create.mutate(body, {
      onSuccess: () => { setAdding(false); setForm({ issuer: "", clientId: "", clientSecret: "", redirectUri: "", label: "", entraTenantId: "" }); notify.success(t("adminConnections.created")); },
      onError,
    });
  };
  const name = (c: AdminConnectionDTO) => {
    if (c.preset === "google") return "Google";
    if (c.preset === "microsoft") return "Microsoft";
    // defensive: the server refuses non-URL issuers at write now (S4 review F1), but a render
    // helper must never be able to white-screen the settings page over one bad row
    try { return c.label || new URL(c.issuer).host; } catch { return c.label || c.issuer; }
  };

  return (
    <div className="mt-8 border-t border-border pt-4" data-testid="admin-connections">
      <h3 className="mt-0 text-sm font-medium">{t("adminConnections.title")}</h3>
      <p className="mt-0 mb-3 text-xs text-fg-dim">{t("adminConnections.body")}</p>

      <div className="flex flex-col gap-1.5" data-testid="admin-connections-list">
        {rows.map((c, i) => (
          <div key={c.id} className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm" data-testid={`admin-connection-${c.id}`}>
            <div className="min-w-0 flex-1">
              <span className="font-medium">{name(c)}</span>
              <span className="ml-2 text-xs text-fg-dim">{c.preset ? t("adminConnections.presetBadge", { preset: c.preset }) : c.issuer}</span>
              {c.subjectPrefix === null && <span className="ml-2 rounded bg-bg-subtle px-1.5 py-px text-[10px] uppercase tracking-wide text-fg-dim">{t("adminConnections.legacyBadge")}</span>}
            </div>
            <IconButton aria-label={t("adminConnections.moveUp")} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></IconButton>
            <IconButton aria-label={t("adminConnections.moveDown")} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></IconButton>
            <Switch checked={c.enabled} ariaLabel={t("adminConnections.enabled")} testId={`admin-connection-enabled-${c.id}`}
              onChange={(on: boolean) => update.mutate({ id: c.id, enabled: on }, { onError })} />
            {/* #504: red at rest + confirm — a deleted connection's minted identities never reconnect */}
            <IconButton aria-label={t("adminConnections.delete")} variant="danger" data-testid={`admin-connection-delete-${c.id}`}
              onClick={() => setDeleting(c)}><X size={14} /></IconButton>
          </div>
        ))}
        {rows.length === 0 && !connections.isLoading && <p className="text-sm text-fg-dim">{t("adminConnections.empty")}</p>}
      </div>

      {!adding && (
        <Button variant="default" size="sm" className="mt-3" data-testid="admin-connection-add" onClick={() => setAdding(true)}>
          {t("adminConnections.add")}
        </Button>
      )}
      {adding && (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-border bg-panel p-3" data-testid="admin-connection-form">
          <label className="flex flex-col gap-1 text-xs text-fg-dim">
            {t("adminConnections.preset")}
            <Select size="sm" value={preset} ariaLabel={t("adminConnections.preset")} testId="admin-connection-preset"
              options={[
                { value: "", label: t("adminConnections.presetNone") },
                { value: "google", label: "Google" },
                { value: "microsoft", label: "Microsoft" },
              ]}
              onChange={setPreset} />
          </label>
          {preset === "" && (
            <>
              <Input inputSize="sm" placeholder={t("adminConnections.issuerPlaceholder")} value={form.issuer} aria-label="issuer"
                onChange={(e) => setForm({ ...form, issuer: e.target.value })} data-testid="admin-connection-issuer" />
              <Input inputSize="sm" placeholder={t("adminConnections.labelPlaceholder")} value={form.label} aria-label="label"
                onChange={(e) => setForm({ ...form, label: e.target.value })} data-testid="admin-connection-label" />
            </>
          )}
          {preset === "microsoft" && (
            <Input inputSize="sm" placeholder={t("adminConnections.entraPlaceholder")} value={form.entraTenantId} aria-label="entra tenant id"
              onChange={(e) => setForm({ ...form, entraTenantId: e.target.value })} data-testid="admin-connection-entra" />
          )}
          <Input inputSize="sm" placeholder={t("adminConnections.clientIdPlaceholder")} value={form.clientId} aria-label="client id"
            onChange={(e) => setForm({ ...form, clientId: e.target.value })} data-testid="admin-connection-clientid" />
          <Input inputSize="sm" type="password" placeholder={t("adminConnections.secretPlaceholder")} value={form.clientSecret} aria-label="client secret"
            onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} />
          <Input inputSize="sm" placeholder={t("adminConnections.redirectPlaceholder")} value={form.redirectUri} aria-label="redirect uri"
            onChange={(e) => setForm({ ...form, redirectUri: e.target.value })} data-testid="admin-connection-redirect" />
          <label className="flex items-center gap-2 text-xs text-fg-dim">
            <Switch checked={flags.trustGroups} ariaLabel={t("adminConnections.trustGroups")} testId="admin-connection-trust-groups"
              onChange={(on: boolean) => setFlags({ ...flags, trustGroups: on })} />
            {t("adminConnections.trustGroups")}
          </label>
          <label className="flex items-center gap-2 text-xs text-fg-dim">
            <Switch checked={flags.bootstrapEligible} ariaLabel={t("adminConnections.bootstrapEligible")} testId="admin-connection-bootstrap"
              onChange={(on: boolean) => setFlags({ ...flags, bootstrapEligible: on })} />
            {t("adminConnections.bootstrapEligible")}
          </label>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" data-testid="admin-connection-save" disabled={create.isPending} onClick={submit}>
              {t("common.save")}
            </Button>
            <Button variant="default" size="sm" onClick={() => setAdding(false)}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t("adminConnections.deleteTitle")}
        message={deleting ? t("adminConnections.deleteConfirm", { name: name(deleting) }) : ""}
        confirmTestId="admin-connection-delete-confirm"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id, { onSuccess: () => notify.success(t("adminConnections.deleted")), onError });
          setDeleting(null);
        }}
      />
    </div>
  );
}
