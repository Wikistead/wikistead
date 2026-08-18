import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useScimTokens, useCreateScimToken, useRevokeScimToken, type ScimTokenCreated } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Trash2 } from "lucide-react";
import { Input } from "../ui/Input";
import { ListRow, ListBox } from "../ui/list-rows";
import { ConfirmDialog } from "../ui/dialogs"; // #504: revoking a live SCIM token cuts a running sync
import { OneTimeSecret } from "../ui/OneTimeSecret";
import { UpgradeNotice } from "../ui/UpgradeNotice";
import { disclosureKindFromError } from "../ui/upgrade-affordance";
import { relTime } from "../ui/relative-time";
import { notify } from "../ui/toast";

// #723 / ADR-232: the SCIM setup surface.
//
// Every SCIM byte shipped long ago — the RFC 7644 router, token issuance, entitlement gates, seat
// enforcement — and no screen minted the bearer token an IdP needs, so the only way in was curl
// against a route you had to find in the docs, copying a plaintext that is returned exactly once.
// The product even told administrators SCIM existed (the members list shows "deactivated by SCIM")
// while giving them no way to start it. Same class as #687 and #660: a capability whose door was
// never drawn.
//
// The tab appears only where the build serves SCIM (the server's surface registry consults the
// composition marker), and a Cloud tenant below the entitled plan lands here to find the upgrade
// notice rather than an empty table — ADR-072's rule that an entitlement loss shows the upgrade
// while an authz loss hides.
export function AdminScimTab() {
  const { t, i18n } = useTranslation();
  const tokens = useScimTokens();
  const create = useCreateScimToken();
  const revoke = useRevokeScimToken();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<ScimTokenCreated | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ id: string; name: string } | null>(null);

  const err = tokens.error as { code?: string } | null;
  const locked = err?.code === "scim_not_entitled";
  const rows = tokens.data ?? [];

  // The URL the customer pastes into their IdP. Top-level, not under the app's /api base
  // (ADR-070, ruling) — and derived from the page's own origin rather than written down,
  // because a hand-typed host is wrong for every tenant but one.
  const baseUrl = typeof window === "undefined" ? "/scim/v2" : `${window.location.origin}/scim/v2`;

  const onCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    create.mutate(trimmed, {
      onSuccess: (r) => { setCreated(r); setName(""); },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  // ADR-072 through the shared affordance: an entitlement loss offers the upgrade to an admin,
  // an authz loss never does. The tab is admin-gated, so isAdmin holds by construction here.
  if (locked) return <UpgradeNotice kind={disclosureKindFromError(err)} isAdmin testId="scim-upgrade" title={t("adminScim.lockedTitle")} body={t("adminScim.lockedBody")} />;

  return (
    <section data-testid="admin-scim">
      <h2 className="text-lg font-semibold">{t("adminScim.title")}</h2>
      <p className="mt-1 text-sm text-fg-dim">{t("adminScim.body")}</p>

      {/* The base URL first: an administrator setting SCIM up needs this string before anything
          else, and until now it appeared in no product surface at all. */}
      <div className="mt-5 rounded-lg border border-border p-4">
        <div className="text-xs uppercase tracking-[0.03em] text-fg-dim">{t("adminScim.endpoint")}</div>
        <code className="mt-1 block break-all text-sm" data-testid="scim-base-url">{baseUrl}</code>
      </div>

      <div className="mt-5 flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[12rem] text-sm">
          <span className="block text-fg-dim">{t("adminScim.tokenName")}</span>
          <Input className="mt-1 w-full" value={name} onChange={(e) => setName(e.target.value)} data-testid="scim-token-name" />
        </label>
        <Button onClick={onCreate} disabled={!name.trim() || create.isPending} data-testid="scim-token-create">
          {t("adminScim.create")}
        </Button>
      </div>

      {/* #638the shared box owns its wording — the caller passes the value, nothing else. */}
      {created && <OneTimeSecret value={created.plaintext} testId="scim-token-plaintext" />}

      <ListBox className="mt-5" data-testid="scim-token-list">
        {rows.map((k) => (
          <ListRow key={k.id} data-testid="scim-token-item">
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{k.name}</span>
            <span className="flex-none font-mono text-xs text-fg-dim">{k.tokenPrefix}…</span>
            {/* lastUsedAt answers the first question when provisioning silently does nothing:
                did the IdP ever connect? */}
            <span className="flex-none text-xs text-fg-dim" data-testid="scim-token-last-used">
              {k.lastUsedAt ? relTime(k.lastUsedAt, i18n.language).rel : t("adminScim.neverUsed")}
            </span>
            <IconButton aria-label={t("adminScim.revoke")} data-testid="scim-token-revoke" variant="danger"
              onClick={() => setPendingRevoke({ id: k.id, name: k.name })}>
              <Trash2 aria-hidden className="h-4 w-4" />
            </IconButton>
          </ListRow>
        ))}
        {rows.length === 0 && !tokens.isLoading && <p className="p-4 text-sm text-fg-dim">{t("adminScim.empty")}</p>}
      </ListBox>

      {/* #504: revoking cuts a running sync, so it asks — and names the token it would cut. */}
      <ConfirmDialog
        open={pendingRevoke !== null}
        title={t("adminScim.revokeTitle")}
        message={pendingRevoke ? t("adminScim.revokeBody", { name: pendingRevoke.name }) : ""}
        confirmLabel={t("adminScim.revoke")}
        confirmTestId="scim-token-revoke-confirm"
        onClose={() => setPendingRevoke(null)}
        onConfirm={() => {
          if (pendingRevoke) revoke.mutate(pendingRevoke.id, { onError: () => notify.error(t("toast.actionFailed")) });
          setPendingRevoke(null);
        }}
      />
    </section>
  );
}
