import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, X } from "lucide-react";
import {
  useAdminConnections, useCreateConnection, useUpdateConnection, useDeleteConnection, useReorderConnections,
  useLoginMethods, useUpdatePlatformLogin, useTenantSaml, useTestTenantOidc,
  type AdminConnectionDTO, type LoginMethodState,
} from "../data/queries";
import { ApiError } from "../data/apiClient";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";
import { AdminSamlSection, samlSectionState } from "./AdminSamlSection";
import { methodBadge } from "./login-method-badge";

// #589 / ADR-195 addendum: ONE list of sign-in methods. A row is one way in — each OIDC connection,
// SAML, and platform login — and every row is edited IN PLACE. What this replaces:
//
//   - a "Login methods" status card that repeated the state each row already carries,
//   - a legacy single-OIDC form that always wrote `ORDER BY sort, id LIMIT 1`, so the SECOND
//     connection could not be edited at all and the FIRST was edited without saying so,
//   - three flags (groups claim, group trust, bootstrap eligibility) that only creation could set.
//
// In-row expansion rather than a side panel, deliberately: this list exists because editing lived in
// two places, and a panel would be the third. `enabled` (what the tenant chose) and `effective` (what
// actually answers a login) are different facts and get different badges — a connection whose secret
// cannot be decrypted is enabled and not effective, and saying only one of them hides that.

// A blank editor form for a connection row.
interface Draft { issuer: string; clientId: string; clientSecret: string; redirectUri: string; scopes: string; groupsClaim: string; label: string }
const draftOf = (c: AdminConnectionDTO): Draft => ({
  issuer: c.issuer, clientId: c.clientId, clientSecret: "", redirectUri: c.redirectUri,
  scopes: c.scopes ?? "", groupsClaim: c.groupsClaim ?? "", label: c.label ?? "",
});

// The row's name: the brand for a preset, else the admin's label, else the issuer's host.
export function connectionName(c: Pick<AdminConnectionDTO, "preset" | "label" | "issuer">): string {
  if (c.preset === "google") return "Google";
  if (c.preset === "microsoft") return "Microsoft";
  // defensive: the server refuses non-URL issuers at write (S4 review F1), but a render helper must
  // never white-screen the settings page over one bad row
  try { return c.label || new URL(c.issuer).host; } catch { return c.label || c.issuer; }
}

export function AdminSignInMethodsSection() {
  const { t } = useTranslation();
  const connections = useAdminConnections();
  const create = useCreateConnection();
  const update = useUpdateConnection();
  const remove = useDeleteConnection();
  const reorder = useReorderConnections();
  const methods = useLoginMethods();
  const platform = useUpdatePlatformLogin();
  const saml = useTenantSaml();
  const test = useTestTenantOidc();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const [adding, setAdding] = useState(false);
  const [preset, setPreset] = useState("");
  const [form, setForm] = useState({ issuer: "", clientId: "", clientSecret: "", redirectUri: "", label: "", entraTenantId: "" });
  const [flags, setFlags] = useState({ bootstrapEligible: false, trustGroups: false });
  const [deleting, setDeleting] = useState<AdminConnectionDTO | null>(null);

  const rows = connections.data ?? [];
  const m = methods.data?.methods;
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
  const openEditor = (c: AdminConnectionDTO) => {
    if (expanded === c.id) { setExpanded(null); return; }
    setExpanded(c.id); setDraft(draftOf(c)); setTestResult(null);
  };
  const saveRow = (c: AdminConnectionDTO) => {
    if (!draft) return;
    update.mutate(
      {
        id: c.id,
        // A preset connection owns its issuer and refuses a label (the brand is not an admin string
        // that reaches the anonymous login screen) — the editor does not offer either field, so it
        // must not send them. For a preset-less row the label is sent even when EMPTY: the server
        // reads "" as "clear it", and omitting it would make a cleared label silently keep the old
        // one (a field the admin can set but never unset).
        ...(c.preset ? {} : { issuer: draft.issuer, label: draft.label }),
        clientId: draft.clientId,
        ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
        redirectUri: draft.redirectUri,
        scopes: draft.scopes,
        groupsClaim: draft.groupsClaim.trim() || null,
      },
      {
        onSuccess: () => { notify.success(t("toast.saved")); setDraft({ ...draft, clientSecret: "" }); },
        onError,
      },
    );
  };
  const onTest = (issuer: string) => {
    setTestResult(null);
    test.mutate(issuer.trim(), {
      onSuccess: (r) => setTestResult(r),
      onError: () => setTestResult({ ok: false, error: t("adminAuth.testFail") }),
    });
  };
  const submitNew = () => {
    const base =
      preset === "google" ? { preset, clientId: form.clientId, clientSecret: form.clientSecret || undefined, redirectUri: form.redirectUri }
      : preset === "microsoft" ? { preset, clientId: form.clientId, clientSecret: form.clientSecret || undefined, redirectUri: form.redirectUri, entraTenantId: form.entraTenantId }
      : { issuer: form.issuer, clientId: form.clientId, clientSecret: form.clientSecret || undefined, redirectUri: form.redirectUri, label: form.label || undefined };
    // ADR-197 §2 rev2 / §6: the two TRUST flags are explicit and default off. They are editable on the
    // row now (#589), but a connection still starts without either.
    create.mutate({ ...base, bootstrapEligible: flags.bootstrapEligible, trustGroups: flags.trustGroups }, {
      onSuccess: () => { setAdding(false); setForm({ issuer: "", clientId: "", clientSecret: "", redirectUri: "", label: "", entraTenantId: "" }); notify.success(t("adminConnections.created")); },
      onError,
    });
  };
  const onTogglePlatform = (on: boolean) => {
    platform.mutate(on, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: (e) => {
        const code = e instanceof ApiError ? e.code : undefined;
        notify.error(code === "own_idp_required" ? t("adminAuth.platformOwnIdpRequired") : t("adminAuth.methodsSaveFailed"));
      },
    });
  };

  // Two badges, because they are two facts: what the tenant chose, and what a login would actually
  // find. The second is only worth a badge when it CONTRADICTS the first (policy, plan, or a
  // configuration that cannot answer) — an effective row would otherwise carry a badge saying what
  // its own switch already says.
  const stateBadges = (enabled: boolean, method?: LoginMethodState & { entitled?: boolean }) => {
    const badge = method ? methodBadge(method) : undefined;
    const contradiction = enabled && badge && badge !== "effective" ? badge : null;
    return (
      <span className="flex items-center gap-2">
        <span className={enabled ? "text-xs text-[#2da44e]" : "text-xs text-fg-dim"} data-testid="sign-in-method-state">
          {t(enabled ? "adminAuth.method_effective" : "adminAuth.method_off")}
        </span>
        {contradiction && (
          <span className="text-xs text-fg-dim" data-testid="sign-in-method-blocked">{t(`adminAuth.method_${contradiction}`)}</span>
        )}
      </span>
    );
  };

  const samlState = samlSectionState(saml);
  const showPlatform = !!m && m["platform-oidc"].configured && m["platform-oidc"].inCeiling;

  return (
    <div data-testid="sign-in-methods">
      <h3 className="mt-0 text-sm font-medium">{t("signInMethods.title")}</h3>
      <p className="mt-0 mb-3 text-xs text-fg-dim">{t("signInMethods.body")}</p>

      <div className="flex flex-col gap-1.5" data-testid="sign-in-methods-list">
        {rows.map((c, i) => (
          <div key={c.id} className="flex flex-col gap-1.5 rounded-md border border-border bg-panel px-3 py-2 text-sm" data-testid={`admin-connection-${c.id}`}>
            <div className="flex items-center gap-2">
              <IconButton aria-label={t("signInMethods.edit")} data-testid={`admin-connection-edit-${c.id}`} onClick={() => openEditor(c)}>
                {expanded === c.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </IconButton>
              {/* A long issuer used to wrap under the row's buttons. It is one line, clipped: the
                  full value is in the editor a click away. */}
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="flex-none font-medium">{connectionName(c)}</span>
                <span className="min-w-0 truncate text-xs text-fg-dim" data-testid={`admin-connection-issuer-${c.id}`}>
                  {c.preset ? t("adminConnections.presetBadge", { preset: c.preset }) : c.issuer}
                </span>
              </div>
              {stateBadges(c.enabled, m?.["tenant-oidc"])}
              {/* Order IS the login screen's order, so it only means something with more than one row. */}
              {rows.length > 1 && (
                <>
                  <IconButton aria-label={t("adminConnections.moveUp")} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={14} /></IconButton>
                  <IconButton aria-label={t("adminConnections.moveDown")} disabled={i === rows.length - 1} onClick={() => move(i, 1)}><ArrowDown size={14} /></IconButton>
                </>
              )}
              {/* #504: red at rest + confirm — a deleted connection's minted identities never reconnect */}
              <IconButton aria-label={t("adminConnections.delete")} variant="danger" data-testid={`admin-connection-delete-${c.id}`}
                onClick={() => setDeleting(c)}><X size={14} /></IconButton>
            </div>
            <label className="flex w-fit items-center gap-2 text-xs text-fg-dim">
              <Switch checked={c.enabled} ariaLabel={t("adminConnections.enabled")} testId={`admin-connection-enabled-${c.id}`}
                onChange={(on: boolean) => update.mutate({ id: c.id, enabled: on }, { onError })} />
              {t("adminConnections.enabled")}
            </label>
            {/* #592 / ADR-204: MCP access, per connection — in the row, not on a screen of its own. The
                server is the wall (a member of a switched-off connection is refused at the MCP entry
                even holding a valid token); this is the place to say so. A connection that does not
                namespace its subs cannot be recognised there, so its switch is unavailable with the
                reason next to it rather than settable and inert. */}
            <label className="flex w-fit items-center gap-2 text-xs text-fg-dim">
              <Switch checked={c.mcpEnabled} disabled={!c.mcpEnforceable} ariaLabel={t("adminConnections.mcpEnabled")}
                testId={`admin-connection-mcp-${c.id}`}
                onChange={(on: boolean) => update.mutate({ id: c.id, mcpEnabled: on }, { onError })} />
              {t("adminConnections.mcpEnabled")}
              {!c.mcpEnforceable && <span data-testid={`admin-connection-mcp-note-${c.id}`}>{t("adminConnections.mcpUnavailable")}</span>}
            </label>

            {expanded === c.id && draft && (
              <div className="mt-1 flex flex-col gap-2 border-t border-border pt-2" data-testid={`admin-connection-editor-${c.id}`}>
                {/* A preset owns its issuer and refuses a label — offering either would be a field the
                    server rejects. */}
                {!c.preset && (
                  <>
                    <label className="flex flex-col gap-1 text-xs text-fg-dim">
                      {t("adminAuth.issuer")}
                      <Input inputSize="sm" value={draft.issuer} data-testid="oidc-issuer"
                        onChange={(e) => setDraft({ ...draft, issuer: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs text-fg-dim">
                      {t("adminConnections.labelPlaceholder")}
                      <Input inputSize="sm" value={draft.label} data-testid="oidc-label"
                        onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                    </label>
                  </>
                )}
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.clientId")}
                  <Input inputSize="sm" value={draft.clientId} data-testid="oidc-client-id"
                    onChange={(e) => setDraft({ ...draft, clientId: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.clientSecret")}
                  <Input inputSize="sm" type="password" value={draft.clientSecret} data-testid="oidc-client-secret"
                    placeholder={c.hasSecret ? t("adminAuth.clientSecretKeep") : ""}
                    onChange={(e) => setDraft({ ...draft, clientSecret: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.scopes")}
                  <Input inputSize="sm" value={draft.scopes} data-testid="oidc-scopes"
                    onChange={(e) => setDraft({ ...draft, scopes: e.target.value })} />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.redirectUri")}
                  <Input inputSize="sm" value={draft.redirectUri} data-testid="oidc-redirect"
                    onChange={(e) => setDraft({ ...draft, redirectUri: e.target.value })} />
                </label>
                {/* #102 / ADR-055: the id_token claim that carries the user's groups (blank → 'groups'). */}
                <label className="flex flex-col gap-1 text-xs text-fg-dim">
                  {t("adminAuth.groupsClaim")}
                  <Input inputSize="sm" value={draft.groupsClaim} placeholder="groups" data-testid="oidc-groups-claim"
                    onChange={(e) => setDraft({ ...draft, groupsClaim: e.target.value })} />
                </label>
                {/* ADR-197 §6 / #554 S6: these two decide whether the connection's groups are trusted
                    and whether its first member may bootstrap an admin. Creation-only until now, which
                    left a connection permanently unable to sync groups — the flags an admin most needs
                    to change are the ones they could not. */}
                <label className="flex w-fit items-center gap-2 text-xs text-fg-dim">
                  <Switch checked={c.trustGroups} ariaLabel={t("adminConnections.trustGroups")} testId={`admin-connection-trust-groups-${c.id}`}
                    onChange={(on: boolean) => update.mutate({ id: c.id, trustGroups: on }, { onError })} />
                  {t("adminConnections.trustGroups")}
                </label>
                <label className="flex w-fit items-center gap-2 text-xs text-fg-dim">
                  <Switch checked={c.bootstrapEligible} ariaLabel={t("adminConnections.bootstrapEligible")} testId={`admin-connection-bootstrap-${c.id}`}
                    onChange={(on: boolean) => update.mutate({ id: c.id, bootstrapEligible: on }, { onError })} />
                  {t("adminConnections.bootstrapEligible")}
                </label>
                {testResult && (
                  <div className={testResult.ok ? "text-xs text-[#2da44e]" : "text-xs text-destructive"} data-testid="oidc-test-result">
                    {testResult.ok ? t("adminAuth.testOk") : (testResult.error ?? t("adminAuth.testFail"))}
                  </div>
                )}
                <div className="flex gap-2">
                  {/* The only connection-test path in the product (POST /admin/oidc/test): it validates
                      an issuer's discovery document, so it serves any row. */}
                  <Button variant="default" size="sm" data-testid="oidc-test" disabled={test.isPending || !(c.preset ? c.issuer : draft.issuer).trim()}
                    onClick={() => onTest(c.preset ? c.issuer : draft.issuer)}>
                    {test.isPending ? t("adminAuth.testing") : t("adminAuth.test")}
                  </Button>
                  <Button variant="primary" size="sm" data-testid="oidc-save" disabled={update.isPending} onClick={() => saveRow(c)}>
                    {t("common.save")}
                  </Button>
                  <Button variant="default" size="sm" onClick={() => setExpanded(null)}>{t("common.cancel")}</Button>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* SAML is a way in like any other, so it is a row. CE has no SAML at all (the routes live in
            the EE package and answer 404) and gets NO row — a build that cannot offer a feature does
            not advertise it. An unentitled EE plan keeps its row, carrying the upgrade notice. */}
        {samlState.kind !== "hidden" && (
          <div className="flex flex-col gap-1.5 rounded-md border border-border bg-panel px-3 py-2 text-sm" data-testid="sign-in-method-saml">
            <div className="flex items-center gap-2">
              <IconButton aria-label={t("signInMethods.edit")} data-testid="sign-in-method-saml-edit" onClick={() => setExpanded(expanded === "saml" ? null : "saml")}>
                {expanded === "saml" ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </IconButton>
              <div className="min-w-0 flex-1 font-medium">{t("adminAuth.methodSaml")}</div>
              {stateBadges(samlState.kind === "form" && !!samlState.data?.enabled, m?.saml)}
            </div>
            {expanded === "saml" && <AdminSamlSection />}
          </div>
        )}

        {/* Platform login: a row with nothing to configure — it is deployed or it is not. Absent when
            this deployment has no platform IdP, or the ceiling excludes it. */}
        {showPlatform && m && (
          <div className="flex items-center gap-2 rounded-md border border-border bg-panel px-3 py-2 text-sm" data-testid="sign-in-method-platform">
            <div className="min-w-0 flex-1 font-medium">{t("adminAuth.methodPlatformOidc")}</div>
            {stateBadges(m["platform-oidc"].selected, m["platform-oidc"])}
            <Switch checked={m["platform-oidc"].selected} onChange={onTogglePlatform} testId="platform-login-toggle"
              ariaLabel={t("adminAuth.methodPlatformOidc")} />
          </div>
        )}

        {rows.length === 0 && !connections.isLoading && samlState.kind === "hidden" && !showPlatform && (
          <p className="text-sm text-fg-dim">{t("adminConnections.empty")}</p>
        )}
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
            <Button variant="primary" size="sm" data-testid="admin-connection-save" disabled={create.isPending} onClick={submitNew}>
              {t("common.save")}
            </Button>
            <Button variant="default" size="sm" onClick={() => setAdding(false)}>{t("common.cancel")}</Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title={t("adminConnections.deleteTitle")}
        message={deleting ? t("adminConnections.deleteConfirm", { name: connectionName(deleting) }) : ""}
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
