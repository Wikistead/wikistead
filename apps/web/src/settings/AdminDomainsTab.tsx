import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "../ui/CopyButton";
import { Trash2 } from "lucide-react";
import {
  useCustomDomains, useAddCustomDomain, useVerifyCustomDomain, useReleaseCustomDomain,
  type CustomDomain,
} from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { ListRow, ListBox } from "../ui/list-rows";
import { ConfirmDialog } from "../ui/dialogs";
import { UpgradeNotice } from "../ui/UpgradeNotice";
import { disclosureKindFromError } from "../ui/upgrade-affordance";
import { notify } from "../ui/toast";
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading

// #721 / ADR-230 §3: the custom-domain surface.
//
// The four routes shipped with #123 and nothing in the product could reach them. Worse, the API was
// not self-describing: verifying under a passkey-only stance needs `acknowledgePasskeyLoss`, whose
// only documentation was a comment inside the route — so even an API client had to read the source
// to succeed. That flag is this screen's confirmation checkbox.
//
// Two refusals travel with verification and both are shown where the attempt happens, rather than
// as a 409 with no explanation:
//   - passkeys_would_be_lost — a passkey only works on the host it was created for (#664), so
//     verifying strands every enrolled key. Confirmable.
//   - passkey_stance_blocks_move — a passkey-only tenant would lock everyone out (#680). NOT
//     confirmable: the server refuses, and the fix is to change the stance first.
export function AdminDomainsTab() {
  const { t } = useTranslation();
  const domains = useCustomDomains();
  const add = useAddCustomDomain();
  const verify = useVerifyCustomDomain();
  const release = useReleaseCustomDomain();
  const [input, setInput] = useState("");
  const [pendingVerify, setPendingVerify] = useState<CustomDomain | null>(null);
  const [pendingRelease, setPendingRelease] = useState<string | null>(null);

  const err = domains.error as { code?: string } | null;
  const locked = err?.code === "customDomain_not_entitled";
  const rows = domains.data ?? [];

  const runVerify = (domain: string, acknowledgePasskeyLoss?: boolean) =>
    verify.mutate({ domain, ...(acknowledgePasskeyLoss ? { acknowledgePasskeyLoss } : {}) }, {
      onError: (e) => {
        const code = (e as { code?: string })?.code;
        // The stance refusal is not confirmable — say why, rather than offering a checkbox that
        // cannot help (#680: with passkeys as the only factor, moving hosts locks everybody out).
        if (code === "passkey_stance_blocks_move") notify.error(t("adminDomains.stanceBlocked"));
        else if (code === "passkeys_would_be_lost") notify.error(t("adminDomains.passkeyRetry"));
        else notify.error(t("toast.actionFailed"));
      },
    });

  // #723 an entitled surface must not be drawn while we do not yet know whether the workspace
  // is entitled. `locked` is derived from an ERROR, and there is no error while the request is in
  // flight — so the subscriber view rendered first, every time, and was then replaced by the upgrade
  // notice. Not a race: on a workspace without the entitlement the 403 always arrives, so the flash
  // always happens. Same guard as AdminSamlSection.tsx, which is the one surface that had it.
  if (domains.isPending) return null;

  // #735: in the pane, like the subscriber view it replaces — a locked tab is still a tab.
  if (locked) {
    return (
      <SettingsPane width="list" title={t("adminDomains.title")}>
        <UpgradeNotice kind={disclosureKindFromError(err)} isAdmin testId="domains-upgrade"
          title={t("adminDomains.lockedTitle")} body={t("adminDomains.lockedBody")} />
      </SettingsPane>
    );
  }

  return (
    <SettingsPane as="section" width="list" testId="admin-domains" title={t("adminDomains.title")} description={t("adminDomains.body")}>

      <div className="mt-5 flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[14rem] text-sm">
          <span className="block text-fg-dim">{t("adminDomains.domain")}</span>
          <Input className="mt-1 w-full" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="docs.example.com" data-testid="domain-input" />
        </label>
        <Button data-testid="domain-add" disabled={!input.trim() || add.isPending}
          onClick={() => add.mutate(input.trim(), {
            onSuccess: () => setInput(""),
            onError: () => notify.error(t("toast.actionFailed")),
          })}>
          {t("adminDomains.add")}
        </Button>
      </div>

      <ListBox className="mt-5" data-testid="domain-list">
        {rows.map((d) => (
          <ListRow key={d.domain} data-testid="domain-item">
            <span className="min-w-0 flex-1">
              <span className="block text-sm [overflow-wrap:anywhere]">{d.domain}</span>
              {/* While pending, the DNS record IS the instruction — without it the screen tells
                  somebody to prove ownership and does not say how. */}
              {/* #721 the record is three fields and a DNS panel takes them in three boxes,
                  so host and value copy SEPARATELY — one copy of the whole sentence cannot be pasted
                  anywhere. The type (TXT) is chosen from a dropdown, never pasted, so it has no
                  button. The control is the product's existing one (CopyButton), not a new one. */}
              {d.status !== "verified" && (
                <span className="mt-1 block text-xs text-fg-dim" data-testid="domain-challenge">
                  <span className="block">{t("adminDomains.dnsHint")}</span>
                  <span className="mt-1 flex items-center gap-1">
                    <span className="flex-none uppercase">{t("adminDomains.dnsType")}</span>
                    <code className="min-w-0 flex-1 [overflow-wrap:anywhere]" data-testid="domain-challenge-host">{d.challengeRecord}</code>
                    <CopyButton value={d.challengeRecord} testId="domain-challenge-host-copy" label={t("adminDomains.copyHost")} />
                  </span>
                  <span className="mt-1 flex items-center gap-1">
                    <code className="min-w-0 flex-1 [overflow-wrap:anywhere]" data-testid="domain-challenge-value">{d.challengeValue}</code>
                    <CopyButton value={d.challengeValue} testId="domain-challenge-value-copy" label={t("adminDomains.copyValue")} />
                  </span>
                </span>
              )}
            </span>
            <span className="flex-none rounded-full border border-border px-2 py-px text-[11px] uppercase tracking-[0.03em] text-fg-dim" data-testid="domain-status">
              {d.status === "verified" ? t("adminDomains.verified") : t("adminDomains.pending")}
            </span>
            {d.status !== "verified" && (
              <Button variant="default" data-testid="domain-verify" disabled={verify.isPending}
                onClick={() => (d.passkeysStranded && d.passkeysStranded > 0 ? setPendingVerify(d) : runVerify(d.domain))}>
                {t("adminDomains.verify")}
              </Button>
            )}
            <IconButton aria-label={t("adminDomains.release")} data-testid="domain-release" variant="danger"
              onClick={() => setPendingRelease(d.domain)}>
              <Trash2 aria-hidden className="h-4 w-4" />
            </IconButton>
          </ListRow>
        ))}
        {rows.length === 0 && !domains.isLoading && <p className="p-4 text-sm text-fg-dim">{t("adminDomains.empty")}</p>}
      </ListBox>

      {/* #664: the passkey consequence, stated BEFORE it commits. Confirming here is what sends
          acknowledgePasskeyLoss — the flag that used to be folklore. */}
      <ConfirmDialog
        open={pendingVerify !== null}
        title={t("adminDomains.passkeyTitle")}
        message={pendingVerify ? t("adminDomains.passkeyBody", { count: pendingVerify.passkeysStranded ?? 0 }) : ""}
        confirmLabel={t("adminDomains.verify")}
        confirmTestId="domain-verify-confirm"
        onClose={() => setPendingVerify(null)}
        onConfirm={() => {
          if (pendingVerify) runVerify(pendingVerify.domain, true);
          setPendingVerify(null);
        }}
      />

      {/* Releasing stops resolution immediately, and re-adding means proving ownership again —
          ADR-230 §2 deliberately does not restore a domain silently. */}
      <ConfirmDialog
        open={pendingRelease !== null}
        title={t("adminDomains.releaseTitle")}
        message={pendingRelease ? t("adminDomains.releaseBody", { domain: pendingRelease }) : ""}
        confirmLabel={t("adminDomains.release")}
        confirmTestId="domain-release-confirm"
        onClose={() => setPendingRelease(null)}
        onConfirm={() => {
          if (pendingRelease) release.mutate(pendingRelease, { onError: () => notify.error(t("toast.actionFailed")) });
          setPendingRelease(null);
        }}
      />
    </SettingsPane>
  );
}
