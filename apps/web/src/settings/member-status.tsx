import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IdCard, KeyRound, Ban } from "lucide-react"; // #544: icons, never text glyphs
import { Tooltip } from "../components/ui/tooltip"; // the RoleTip layer — not a second tooltip school
import type { Member } from "../data/membersApi";

// #614: the member row's status, as data. Pure so the two decisions the ticket pins — which icons a
// member wears, and whether the ⋯ menu still offers a password entrance — are testable without a DOM.
//
// One icon GROUP, not three unrelated marks: the identity icon and the key compose to spell
// the three real states — IdP-born (IdCard), IdP-born with a password added (IdCard + KeyRound),
// password-born (KeyRound alone; a local user IS their password entrance, a second mark would say
// the same thing twice). `deactivated` rides along for the row dim + the Ban mark.
export type MemberStatusKey = "idp" | "password" | "local" | "deactivated";

export function memberStatusKeys(m: Pick<Member, "identity_source" | "has_password" | "deactivated_at">): MemberStatusKey[] {
  const keys: MemberStatusKey[] = [];
  if (m.identity_source === "local") keys.push("local");
  else keys.push("idp"); // absent/oidc: every pre-083 member is IdP-born (the migration's default)
  if (m.has_password && m.identity_source !== "local") keys.push("password");
  if (m.deactivated_at != null) keys.push("deactivated");
  return keys;
}

// #606 → #614: a member who already has a password entrance must not be OFFERED one — that menu
// item could only ever fail (the server's uniform 400). The server stays the fortress; this is the
// convenience layer finally telling the truth. Values only, so the page keeps owning labels/icons.
export function memberMenuValues(m: Pick<Member, "has_password">): ("password" | "erase" | "remove")[] {
  return m.has_password ? ["erase", "remove"] : ["password", "erase", "remove"];
}

const ICON = { idp: IdCard, password: KeyRound, local: KeyRound, deactivated: Ban } as const;

/** One status mark: an icon whose meaning is a hover/focus/tap tooltip (the #586 school — desktop
 *  first, no always-on caption; the label doubles as the accessible name). */
function StatusMark({ k }: { k: MemberStatusKey }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = ICON[k];
  const label = t(`members.status.${k}`);
  return (
    <Tooltip open={open} onOpenChange={setOpen} content={label}>
      {/* a span, like RoleTip's badge: the row already carries controls; this is a readable mark,
          reachable by keyboard, tap-toggled on touch, never a button competing in the focus order */}
      <span
        tabIndex={0}
        aria-label={label}
        data-testid={`member-status-${k}`}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex cursor-help items-center text-fg-dim outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Icon size={14} aria-hidden />
      </span>
    </Tooltip>
  );
}

/** The row's icon group, drawn beside the name. Deactivation also dims the whole row (the page owns
 *  that — opacity belongs to the <tr>, not to a mark inside it). */
export function MemberStatusIcons({ member }: { member: Member }) {
  return (
    <span className="inline-flex items-center gap-1">
      {memberStatusKeys(member).map((k) => (
        <StatusMark key={k} k={k} />
      ))}
    </span>
  );
}
