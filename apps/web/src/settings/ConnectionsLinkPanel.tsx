import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Check } from "lucide-react";
import { Button } from "../ui/Button";
import { notify } from "../ui/toast";
import { ApiError } from "../data/apiClient";
import { startAuthentication } from "@simplewebauthn/browser";
import {
  useMyConnections, useStartConnectionLink, useUnlinkConnection, useMyFactors, useMyRecoveryCodes,
  useRecoveryReauthChallenge, type AccountConnection,
} from "../data/queries";
import { browserCanUseFactorKind, proofBeginsOnChoice } from "./factor-kind";
import { ProviderMark } from "../app/ProviderMark";
import { connectionName } from "../app/LoginScreen";
import { LoadFailed } from "../ui/LoadFailed";
import {
  RecoveryReauthForm, proofsHeld, initialMethod, pickReauthMethod, type ReauthMethod,
} from "./RecoveryCodesPanel";

// #947 / ADR-259 §3.3: an additional OIDC connection is added from HERE, not from the incoming
// sign-in — the ruling's whole point (§3.3's long note) is that the account that already exists is
// where a link is proven, with re-authentication, never inline in a fresh IdP round trip. Reuses the
// SAME reauth form and the SAME three proofs as recovery-code minting beside it: "is the person at the
// keyboard still the account holder" is one question asked in two places, not two questions.
//
// Completing a link is a FULL-PAGE navigation (the browser goes to the IdP and back to
// /auth/link-callback) — there is no second call on this side. What this screen shows on return is
// read from the query string /auth/link-callback redirects to (`?linked=1` / `?linkError=<reason>`),
// the same shape LoginScreen's own `?error=` convention uses.

/** `?linked=1` / `?linkError=<reason>` on THIS page, left by `/auth/link-callback`'s redirect. */
function useLinkResult(): void {
  const { t } = useTranslation();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("linked") === "1") notify.success(t("account.connectionLinked"));
    else if (params.get("linkError") === "taken") notify.error(t("account.connectionLinkTaken"));
    else if (params.get("linkError")) notify.error(t("account.connectionLinkFailed"));
    if (params.has("linked") || params.has("linkError")) {
      params.delete("linked"); params.delete("linkError");
      const qs = params.toString();
      window.history.replaceState(null, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }
    // Fires once, on mount — this is a landing read, not a live subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function ConnectionRow({ conn, onLink, onUnlink, busy }: {
  conn: AccountConnection; onLink: () => void; onUnlink: () => void; busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border p-2" data-testid={`connection-row-${conn.id}`}>
      <div className="flex items-center gap-2 text-sm">
        {conn.brand && <ProviderMark preset={conn.brand} />}
        <span>{connectionName(conn, t)}</span>
      </div>
      {conn.linked ? (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1 text-xs text-fg-dim" data-testid={`connection-linked-${conn.id}`}>
            <Check size={14} aria-hidden />{t("account.connectionLinkedBadge")}
          </span>
          <Button variant="dangerGhost" size="sm" type="button" disabled={busy} data-testid={`connection-unlink-${conn.id}`} onClick={onUnlink}>
            {t("account.connectionUnlinkButton")}
          </Button>
        </div>
      ) : (
        <Button variant="default" type="button" disabled={busy} data-testid={`connection-link-${conn.id}`} onClick={onLink}>
          {t("account.connectionLinkButton")}
        </Button>
      )}
    </div>
  );
}

export function ConnectionsLinkPanel() {
  const { t } = useTranslation();
  useLinkResult();
  const connections = useMyConnections();
  const factors = useMyFactors();
  const recovery = useMyRecoveryCodes(); // shares its cache with RecoveryCodesPanel — no extra request
  const start = useStartConnectionLink();
  const unlink = useUnlinkConnection();
  // Reuses recovery-code minting's passkey challenge: the primitive it mints (a WebAuthn assertion
  // challenge keyed to tenant+member, not to "recovery") is exactly what re-authenticating here needs.
  const challenge = useRecoveryReauthChallenge();

  const [pendingId, setPendingId] = useState<string | null>(null);
  // #1045: link and unlink share ONE re-auth form (same proof, same three methods) — the pending
  // ACTION picks which mutation `submitProof`/`proveWithPasskey` finish into.
  const [pendingAction, setPendingAction] = useState<"link" | "unlink" | null>(null);
  const [proving, setProving] = useState<null | { code: string; password: string }>(null);
  const [method, setMethod] = useState<ReauthMethod | null>(null);

  const methods = proofsHeld({
    factors: factors.data?.factors ?? [],
    hasPassword: recovery.data?.hasPassword === true,
    webauthn: browserCanUseFactorKind("passkey"),
  });
  const onlyMethod = initialMethod(methods);

  const beginAction = (action: "link" | "unlink", id: string) => {
    setPendingId(id);
    setPendingAction(action);
    setProving({ code: "", password: "" });
    setMethod(onlyMethod);
  };
  const cancel = () => { setPendingId(null); setPendingAction(null); setProving(null); setMethod(null); };

  const failed = (e: unknown) => {
    if (e instanceof ApiError && e.code === "reauth_required") return notify.error(t("account.connectionReauthFailed"));
    if (e instanceof ApiError && e.code === "factor_locked") return notify.error(t("account.recoveryReauthFailed"));
    if (e instanceof ApiError && e.code === "last_way_in") return notify.error(t("account.connectionUnlinkLastWay"));
    notify.error(pendingAction === "unlink" ? t("account.connectionUnlinkFailed") : t("account.connectionLinkFailed"));
  };

  const goToUrl = (res: { url: string } | null | undefined) => {
    if (!res?.url) return notify.error(t("account.connectionLinkFailed"));
    window.location.href = res.url; // full-page navigation to the IdP — never returns to this render
  };

  const finishUnlink = async (connectionId: string, proof: { password?: string; code?: string; passkey?: unknown }) => {
    await unlink.mutateAsync({ connectionId, proof });
    notify.success(t("account.connectionUnlinked"));
    cancel();
  };

  const submitProof = async () => {
    if (!proving || !pendingId) return;
    try {
      const proof = method === "totp" ? { code: proving.code.trim() } : method === "password" ? { password: proving.password } : {};
      if (pendingAction === "unlink") await finishUnlink(pendingId, proof);
      else goToUrl(await start.mutateAsync({ connectionId: pendingId, proof }));
    } catch (e) { failed(e); }
  };

  const proveWithPasskey = async () => {
    if (!pendingId) return;
    try {
      const started = await challenge.mutateAsync();
      if (!started?.options) return notify.error(t("account.connectionReauthFailed"));
      const assertion = await startAuthentication({ optionsJSON: started.options as never });
      if (pendingAction === "unlink") await finishUnlink(pendingId, { passkey: assertion });
      else goToUrl(await start.mutateAsync({ connectionId: pendingId, proof: { passkey: assertion } }));
    } catch (e) {
      if (e instanceof ApiError) return failed(e);
      // A dismissed key prompt lands here too — the reader cancelled, not a refusal worth explaining.
      notify.error(t("account.connectionReauthFailed"));
    }
  };

  const rows = (connections.data ?? []).filter((c) => c.kind === "oidc" || c.kind === "platform");
  // Nothing to show while loading, and nothing to offer on a tenant with no OIDC/platform connection
  // at all (password-only) — a section whose only content is "there is nothing here" is a dead end,
  // not information. A FETCH failure is different: it is reported, not hidden, same as the API-keys
  // panel beside it (#895's lesson — an empty read and a failed one must not look alike).
  if (connections.isLoading) return null;
  if (connections.isError) return (
    <div className="mt-6" data-testid="connections-link-panel">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Link2 size={14} aria-hidden />
        {t("account.connectionsTitle")}
      </h3>
      <LoadFailed testId="connections-link-failed" onRetry={() => { void connections.refetch(); }} />
    </div>
  );
  if (rows.length === 0) return null;

  return (
    <div className="mt-6" data-testid="connections-link-panel">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
        <Link2 size={14} aria-hidden />
        {t("account.connectionsTitle")}
      </h3>
      <p className="mb-2 text-xs text-fg-dim" data-testid="connections-explainer">{t("account.connectionsExplainer")}</p>
      <div className="flex flex-col gap-2">
        {rows.map((conn) =>
          pendingId === conn.id && proving ? (
            <RecoveryReauthForm key={conn.id} method={method} methods={methods} proving={proving} onChange={setProving}
              onPick={(m) => pickReauthMethod(m, {
                setMethod, resetProof: () => setProving({ code: "", password: "" }), present: () => void proveWithPasskey(),
              })}
              busy={start.isPending || unlink.isPending} passkeyBusy={challenge.isPending}
              onSubmit={() => void submitProof()} onPasskey={() => void proveWithPasskey()}
              onCancel={cancel}
              prompt={pendingAction === "unlink" ? t("account.connectionUnlinkReauthPrompt") : t("account.connectionLinkReauthPrompt")}
              passkeyLabel={pendingAction === "unlink" ? t("account.connectionUnlinkReauthPasskey") : t("account.connectionLinkReauthPasskey")}
              submitLabel={pendingAction === "unlink" ? t("account.connectionUnlinkButton") : t("account.connectionLinkButton")} />
          ) : (
            <ConnectionRow key={conn.id} conn={conn} busy={start.isPending || unlink.isPending}
              onLink={() => (methods.length === 0
                ? notify.error(t("account.connectionNoProof"))
                : beginAction("link", conn.id))}
              onUnlink={() => (methods.length === 0
                ? notify.error(t("account.connectionNoProof"))
                : beginAction("unlink", conn.id))} />
          ),
        )}
      </div>
    </div>
  );
}
