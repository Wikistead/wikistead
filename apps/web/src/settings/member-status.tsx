import { useState } from "react";
import { useTranslation } from "react-i18next";
import { IdCard, KeyRound, Ban, Hourglass } from "lucide-react"; // #544: icons, never text glyphs
import { Tooltip } from "../components/ui/tooltip"; // the RoleTip layer — not a second tooltip school
import type { Member } from "../data/membersApi";

// #614: the member row's status, as data. Pure so the two decisions the ticket pins — which icons a
// member wears, and whether the ⋯ menu still offers a password entrance — are testable without a DOM.
//
// One icon GROUP, not three unrelated marks: the identity icon and the key compose to spell
// the three real states — IdP-born (IdCard), IdP-born with a password added (IdCard + KeyRound),
// password-born (KeyRound alone; a local user IS their password entrance, a second mark would say
// the same thing twice). `deactivated` rides along for the row dim + the Ban mark.
// #1054 / ADR-275 rev3 §4: "pending" rides beside the other marks, not in place of them — a pending
// member is FULLY ACTIVE (ADR-275 §1, "not a new state"), so it can appear next to any combination the
// other four keys already draw, never instead of one.
export type MemberStatusKey = "idp" | "password" | "local" | "deactivated" | "pending";

export function memberStatusKeys(m: Pick<Member, "identity_source" | "has_password" | "deactivated_at" | "pending_scim_removal_at">): MemberStatusKey[] {
  const keys: MemberStatusKey[] = [];
  if (m.identity_source === "local") keys.push("local");
  else keys.push("idp"); // absent/oidc: every pre-083 member is IdP-born (the migration's default)
  if (m.has_password && m.identity_source !== "local") keys.push("password");
  if (m.deactivated_at != null) keys.push("deactivated");
  if (m.pending_scim_removal_at != null) keys.push("pending");
  return keys;
}

// #606 → #614: the row's actions, by state.
//
// The first cut REMOVED the password item from anyone who already had one, because the server refused
// them and an item that can only fail is worse than no item. The review then found what that
// refusal cost: an admin could not hand a reset link to somebody who had forgotten their password and
// could not read mail — and under `sso_required` that person's password IS the way back in (#605).
//
// So the item stays for everyone and its MEANING changes: give an entrance to somebody with none, or
// re-issue a link for somebody who has one. Same server route, same `pwr_` token; the page picks the
// words from `passwordAction` so the two are never one sentence.
export function memberMenuValues(m: Pick<Member, "has_password" | "has_another_way_in" | "identity_source" | "deactivated_at" | "deactivation_reason" | "has_factor">): MemberMenuValue[] {
  // #626 / ADR-214: removing the entrance is an ADDITIONAL item, never a replacement for the one above it.
  // #614 settled that "they already have a password" must not take the grant/reissue item away — the reset
  // link is the only route left for a tenant with no working mail, which is exactly #605's break-glass
  // member. So a member with a password sees both.
  //
  // Somebody whose ONLY way in is that password does not see it at all: the server refuses with
  // `last_way_in`, and offering an action that cannot succeed is the defect #596 and #606 are about.
  // #949: `identity_source` is who MINTED the identity, not whether another way in exists TODAY (a
  // `local` member may have since linked a provider; an `oidc` member's connection may have since been
  // deleted) — read `has_another_way_in`, the field the server computes with the same predicate it
  // refuses the write with.
  const removable = m.has_password && m.has_another_way_in === true;
  // #627: suspend, or bring back — never both, and never on somebody the server would refuse. A member
  // frozen by a plan downgrade or removed by the directory shows neither: the console does not own those
  // suspensions (rulings 4 and 5 put the first behind an admin decision and the second in the directory).
  const suspension = m.deactivated_at
    ? (m.deactivation_reason === "admin" ? (["reactivate"] as const) : ([] as const))
    : (["suspend"] as const);
  // #644 only for somebody who HOLDS one. The reset succeeds on a member with no factors — it
  // deletes nothing and answers 200 — so an always-offered item would report having helped when it did
  // not, which is worse than the always-failing button #596/#606 are about.
  const factorReset = m.has_factor ? (["factorReset"] as const) : ([] as const);
  return ["password", ...(removable ? (["passwordRemove"] as const) : []), ...factorReset, ...suspension, "erase", "remove"];
}
export type MemberMenuValue = "password" | "passwordRemove" | "factorReset" | "suspend" | "reactivate" | "erase" | "remove";

/** Which of the two the password item is for this member — the label, the toast and the audit differ. */
export function passwordAction(m: Pick<Member, "has_password">): "grant" | "reissue" {
  return m.has_password ? "reissue" : "grant";
}

const ICON = { idp: IdCard, password: KeyRound, local: KeyRound, deactivated: Ban, pending: Hourglass } as const;

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
