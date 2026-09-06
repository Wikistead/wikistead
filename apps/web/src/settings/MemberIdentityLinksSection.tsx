import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Unlink } from "lucide-react";
import { useMemberIdentityLinks, useAdminUnlinkMemberIdentity, type MemberIdentityLink } from "../data/queries";
import { connectionName } from "../app/LoginScreen";
import { ListRow, ListBox } from "../ui/list-rows"; // #623 slice 10: every row-list lives in the shared, bounded box
import { IconButton } from "../ui/Button";
import { ConfirmDialog } from "../ui/dialogs";
import { notify } from "../ui/toast";
import { ApiError } from "../data/apiClient";

// #1107 / ADR-280 (rev6): the expand-in-place section a member's row reveals — never a popover (the
// ruling's own reasoning: a face reachable only by hover cannot be linked, shared, or reached by
// keyboard). Two fields per link (`connectionName`, `linkedAt`); `primaryIdentitySource` restates the
// roster's own fact so an empty link list never reads as "no way in" for an ordinary member who has
// never linked anything additional.
//
// #1163 / ADR-283 §7: each row gains a small, deliberately unalarming unlink icon-button — the same
// destructive-icon treatment `IconButton`'s own `variant="danger"` gives every other icon-only delete
// action (`AdminWebhooksTab.tsx`'s endpoint delete, etc.); `ConnectionsLinkPanel.tsx`'s own unlink
// button is a text `Button` with `variant="dangerGhost"`, a different component for a different shape
// of row. No client-side confirm dialog is required by the server's own protocol (the guard returns a
// hard 409, not a `confirm_required` shape), but a confirm step is still good UX for a destructive
// action on someone else's account.
export function MemberIdentityLinksSection({ sub, name }: { sub: string; name: string }) {
  const { t, i18n } = useTranslation();
  const q = useMemberIdentityLinks(sub, true);
  const unlink = useAdminUnlinkMemberIdentity(sub);
  const [confirming, setConfirming] = useState<MemberIdentityLink | null>(null);

  if (q.isLoading) {
    return <div className="p-2 text-xs text-fg-dim" data-testid="member-identities-loading">{t("common.loading")}</div>;
  }
  if (q.isError || !q.data) {
    return <div className="p-2 text-xs text-fg-dim" data-testid="member-identities-error">{t("members.identitiesLoadFailed")}</div>;
  }

  const { primaryIdentitySource, links } = q.data;
  // #949 / member-status.tsx's own convention: never show the raw `identity_source` value — it is a
  // machine enum ('oidc'/'local'), not product copy. Mirrors `memberStatusKeys`'s binary treatment
  // (every value but 'local' reads as IdP-born, the migration's own default for pre-083 members).
  const primarySourceLabel = primaryIdentitySource === "local" ? t("members.identitiesSourceLocal") : t("members.identitiesSourceIdp");
  const nameOf = (link: MemberIdentityLink) =>
    link.connectionName ? connectionName({ id: link.connectionId, ...link.connectionName }, t) : t("members.identitiesConnectionGone");

  const doUnlink = () => {
    if (!confirming) return;
    const link = confirming;
    setConfirming(null);
    unlink.mutate(link.linkId, {
      onSuccess: () => notify.success(t("members.identitiesUnlinkDone")),
      onError: (e: unknown) => {
        if (e instanceof ApiError && e.code === "last_way_in") {
          return notify.error(t("members.identitiesUnlinkLastWayIn", { name }));
        }
        if (e instanceof ApiError && e.code === "reset_self") {
          return notify.error(t("members.identitiesUnlinkSelfRefused"));
        }
        notify.error(t("members.identitiesUnlinkFailed"));
      },
    });
  };

  return (
    <div className="flex flex-col gap-1 rounded-md bg-panel-2 p-2 text-xs" data-testid="member-identities-section">
      <div className="text-fg-dim">{t("members.identitiesPrimarySource", { source: primarySourceLabel })}</div>
      {links.length === 0 ? (
        <div className="text-fg-dim">{t("members.identitiesEmpty")}</div>
      ) : (
        <ListBox>
          {links.map((link) => (
            <ListRow key={link.linkId} className="justify-between" data-testid="member-identity-link-row">
              <span>{nameOf(link)}</span>
              <span className="flex items-center gap-2">
                <span className="text-fg-dim">{new Date(link.linkedAt).toLocaleDateString(i18n.language)}</span>
                <IconButton aria-label={t("members.identitiesUnlink")} data-testid="member-identity-unlink"
                  variant="danger" disabled={unlink.isPending} onClick={() => setConfirming(link)}>
                  <Unlink size={12} />
                </IconButton>
              </span>
            </ListRow>
          ))}
        </ListBox>
      )}
      <ConfirmDialog
        open={confirming !== null}
        confirmTestId="member-identity-unlink-confirm"
        message={confirming ? t("members.identitiesUnlinkConfirm", { name, connection: nameOf(confirming) }) : ""}
        onClose={() => setConfirming(null)}
        onConfirm={doUnlink}
      />
    </div>
  );
}
