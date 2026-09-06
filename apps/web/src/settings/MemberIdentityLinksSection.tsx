import { useTranslation } from "react-i18next";
import { useMemberIdentityLinks } from "../data/queries";
import { connectionName } from "../app/LoginScreen";
import { ListRow, ListBox } from "../ui/list-rows"; // #623 slice 10: every row-list lives in the shared, bounded box

// #1107 / ADR-280 (rev6): the expand-in-place section a member's row reveals — never a popover (the
// ruling's own reasoning: a face reachable only by hover cannot be linked, shared, or reached by
// keyboard). Two fields per link (`connectionName`, `linkedAt`); `primaryIdentitySource` restates the
// roster's own fact so an empty link list never reads as "no way in" for an ordinary member who has
// never linked anything additional.
export function MemberIdentityLinksSection({ sub }: { sub: string }) {
  const { t, i18n } = useTranslation();
  const q = useMemberIdentityLinks(sub, true);

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
  return (
    <div className="flex flex-col gap-1 rounded-md bg-[var(--surface-2,#161616)] p-2 text-xs" data-testid="member-identities-section">
      <div className="text-fg-dim">{t("members.identitiesPrimarySource", { source: primarySourceLabel })}</div>
      {links.length === 0 ? (
        <div className="text-fg-dim">{t("members.identitiesEmpty")}</div>
      ) : (
        <ListBox>
          {links.map((link) => (
            <ListRow key={link.linkId} className="justify-between" data-testid="member-identity-link-row">
              <span>
                {link.connectionName
                  ? connectionName({ id: link.connectionId, ...link.connectionName }, t)
                  : t("members.identitiesConnectionGone")}
              </span>
              <span className="text-fg-dim">{new Date(link.linkedAt).toLocaleDateString(i18n.language)}</span>
            </ListRow>
          ))}
        </ListBox>
      )}
    </div>
  );
}
