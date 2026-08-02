import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { MemberSearchInput } from "../ui/MemberSearchInput";
import {
  useSpaceAccess, useGrantSpaceAccess, useRevokeSpaceAccess, useMemberCandidates, useTenantGroups,
  useCommentOpen, useSetCommentOpen,
  useAssignableRoles, useRoleAssignments, useAssignRole, useUnassignRole,
  type PageRelation,
} from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { resolveGrantDispatch, foldedEditorGrantees, revokeCapsForRow } from "./grant-dispatch";
import { notify } from "../ui/toast";
import { Switch } from "../ui/Switch";
import { ConfirmDialog } from "../ui/dialogs";
import { ApiError } from "../data/apiClient";
// #536 the server's refusal code — the client mirrors the constant instead of a string literal.
export const MANAGER_REPLACEMENT_CODE = "manager_replacement_requires_confirmation";

interface SpaceCtx { spaceId: string; name: string }
// #330 / ADR-141: `moderate` → space#moderator (revert/freeze/patrol + edit; grants/settings stay manage-only).
// #529 / ADR-193: `comment` became a space capability (space#commenter). Two different lists follow from
// that, and conflating them is what the review rejected — "why is a role that isn't in the roles
// list showing up here?".
//
// #536 ①: rows sort by principal NAME (one rule for the merged list) — the old capability-power
// CAP_ORDER sort went with the split lists. #552 (user ruling): `comment` leaves the picker with the
// built-in commenter role — a comment-only grant is composed via a CUSTOM role now; a comment row made
// through the API (or before that change) still DISPLAYS correctly (CAP_NOUN keeps its noun).
// exported for the copy pin (#553): a paragraph that tells the reader how to grant something must
// be checked against the list this picker actually offers, not against a second copy of it.
export const GRANTABLE: PageRelation[] = ["view", "edit", "moderate", "manage"];
// #445 the WIRE value stays the verb (the internal relation — view→viewer_member, edit→editor_member,
// etc. — is unchanged), but the LABEL is the noun a role is called, shown as a literal to match the Roles tab
// (which renders `r.name` verbatim). One noun set across Members and Roles.
const CAP_NOUN: Record<PageRelation, string> = { view: "viewer", comment: "commenter", edit: "editor", moderate: "moderator", manage: "manager" };
const capNoun = (c: string): string => CAP_NOUN[c as PageRelation] ?? c;

// #529 the one-line effective comment audience — the three OR'd routes said as people. Pure so
// the composition (what appears and disappears as the toggles move) is unit-testable; display-only,
// the server's 3-way OR remains the authority.
export function commentAudienceSummary(
  t: (k: string, o?: Record<string, unknown>) => string,
  state: { members: boolean; guests: boolean },
): string {
  // #552 (user ruling): the per-grant commenter count left the summary with the built-in role — the
  // summary now names only editors-always plus whatever the two toggles add.
  const parts = [t("spaceMembers.commentSummaryEditors")];
  if (state.members) parts.push(t("spaceMembers.commentSummaryMembers"));
  if (state.guests) parts.push(t("spaceMembers.commentSummaryGuests"));
  return t("spaceMembers.commentSummaryLead") + parts.join(" + ");
}

// Space Members & Permissions (Phase 5b). manage-gated end-to-end: the screen is
// only reachable by a manager (SpaceSettingsLayout), and every grant/revoke/list
// re-checks space#manage server-side. Granting is the inheritance root — it widens
// access to every published page in the space.
export function SpaceMembersTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<SpaceCtx>();
  const access = useSpaceAccess(spaceId);
  const grant = useGrantSpaceAccess(spaceId);
  const revoke = useRevokeSpaceAccess(spaceId);
  const commentOpen = useCommentOpen(spaceId);
  const setCommentOpen = useSetCommentOpen(spaceId);
  const toggleCommentOpen = (key: "guests" | "members", value: boolean) =>
    setCommentOpen.mutate({ [key]: value }, {
      onSuccess: () => notify.success(t("toast.saved")),
      onError: () => notify.error(t("toast.actionFailed")),
    });

  const [mode, setMode] = useState<"user" | "group">("user");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<{ grantee: string; label: string } | null>(null);
  const [groupName, setGroupName] = useState("");
  const [capability, setCapability] = useState<PageRelation>("view");
  // #536: ONE selection for the merged list. The prefix says which mechanism the choice belongs to, so the
  // add handler dispatches on data rather than inferring it from the shape of an id.
  const [pick, setPick] = useState<string>("builtin:view");
  // #536 ②: 1 principal = 1 role — adding over an existing (different) role REPLACES it. The
  // server converges regardless (the fortress); this confirm is the "no accidental double-grant" UI layer.
  const [pendingAdd, setPendingAdd] = useState<{ run: () => void; who: string; current: string; next: string; manager?: boolean } | null>(null);
  const candidates = useMemberCandidates(spaceId, picked ? "" : query);
  const groups = useTenantGroups(spaceId, mode === "group");

  // #485 / #514: custom-role assignment lives here in space settings (not the tenant Roles tab). The role
  // DEFINITIONS come from the manager-readable list; assign/list/unassign reuse the manage-gated role_assignment
  // routes with resourceType="space". The tenant Roles tab keeps DEFINITION editing; here a manager only ASSIGNS.
  const assignable = useAssignableRoles(spaceId);
  const roleAssignments = useRoleAssignments("space", spaceId);
  const assignRole = useAssignRole();
  const unassignRole = useUnassignRole();
  const customRoles = assignable.data?.custom ?? [];
  // #523 / ADR-190 (slice E): the assignment list now arrives with its user principals already NAMED by the
  // server (the same authorization-bounded resolution as the grant list). The old customized-only lookup is
  // gone — it left an un-customised member showing a raw sub, the last hash on this screen.
  const roleNameBySub = new Map(
    (roleAssignments.data ?? [])
      .filter((a) => a.principal.startsWith("user:"))
      .map((a) => [a.principal.replace(/^user:/, ""), a.displayName ?? null] as const),
  );
  // #536 ⑥: a group principal is a HASH — the server resolves the name (group-sync.ts is the id
  // authority); an orphan (group gone at the IdP) gets the explicit label and STAYS revocable.
  const rolePrincipalLabel = (a: { principal: string; groupName?: string }): string => {
    if (a.principal.startsWith("group:")) return `${a.groupName ?? t("spaceMembers.unknownGroup")} (${t("spaceMembers.group")})`;
    const sub = a.principal.replace(/^user:/, "");
    return roleNameBySub.get(sub) || sub; // server-resolved name; raw sub only for a departed/cross-tenant one
  };

  // #536 / ADR-188 §6: one control, two mechanisms underneath. A custom role goes through the assignment
  // path (its bundle expands server-side); a built-in goes through the grant path. Either way the server
  // re-gates on space `manage` — the merge is a UI convenience and moves no authority.
  // The DECISION lives in resolveGrantDispatch (a pure function, behaviourally pinned — review 7
  // the group bug lived in an untestable inline handler); this only executes what it resolved.
  const addUnified = () => {
    const action = resolveGrantDispatch({ pick, mode, picked, groupName });
    if (action.path === "none") return;
    // #536 ②: if this principal already holds a DIFFERENT role, the add is a REPLACEMENT — say so
    // before dispatching (the server replaces regardless; this stops the unnoticed double-grant).
    const nextBadge = action.path === "assign"
      ? (customRoles.find((r) => r.id === action.roleId)?.name ?? "")
      : capNoun(action.path === "grant-composite" ? action.capabilities[0]! : action.capability);
    const who = mode === "group" ? groupName : (picked?.label ?? "");
    const existing = mergedRows.find((r) => {
      if (mode === "group") return r.label === `${groupName} (${t("spaceMembers.group")})`;
      if (!picked) return false;
      return r.kind === "grant" ? r.grantee === picked.grantee : r.principal === picked.grantee;
    });
    // #536 a MANAGER getting a weaker role is its own question, with its own words — this is a
    // demotion, not a swap, and the server refuses it outright without the confirmed `replace` flag. The
    // manager row can also be ROWLESS (the space creator), which is why it shows up here as a grant row
    // at all. Assigning `manage` itself is not a demotion and keeps the ordinary swap wording.
    const demotesManager = existing?.kind === "grant" && existing.capability === "manage"
      && !(action.path === "grant" && action.capability === "manage");
    if (existing && demotesManager && !existing.managed) {
      setPendingAdd({ run: () => dispatchAdd(action, true), who, current: existing.badge, next: nextBadge, manager: true });
      return;
    }
    if (existing && existing.badge !== nextBadge && !existing.managed) {
      setPendingAdd({ run: () => dispatchAdd(action), who, current: existing.badge, next: nextBadge });
      return;
    }
    dispatchAdd(action);
  };

  // The server is the wall: when it answers 409 manager_replacement_requires_confirmation (a manager the
  // list could not show us — e.g. a group principal), open the SAME dialog and retry with the flag rather
  // than showing a dead "action failed" toast.
  const onAddError = (err: unknown, retry: () => void, who: string, next: string) => {
    if (err instanceof ApiError && err.code === MANAGER_REPLACEMENT_CODE) {
      setPendingAdd({ run: retry, who, current: capNoun("manage"), next, manager: true });
      return;
    }
    notify.error(t("toast.actionFailed"));
  };

  const dispatchAdd = (action: ReturnType<typeof resolveGrantDispatch>, replace = false) => {
    if (action.path === "none") return;
    if (action.path === "assign") {
      const target = action.target.kind === "group" ? { groupName: action.target.groupName } : { principal: action.target.principal };
      const who = action.target.kind === "group" ? action.target.groupName : (picked?.label ?? "");
      const next = customRoles.find((r) => r.id === action.roleId)?.name ?? "";
      assignRole.mutate({ roleId: action.roleId, resourceType: "space", resourceId: spaceId, ...target, replace }, {
        onSuccess: () => { notify.success(t("toast.accessGranted")); setPicked(null); setQuery(""); setGroupName(""); },
        onError: (e) => onAddError(e, () => dispatchAdd(action, true), who, next),
      });
      return;
    }
    if (action.path === "grant-composite") {
      // #553 / ADR-199 §2: the editor noun — one control, N single-capability grants in one server tx
      const target = action.target.kind === "group" ? { groupName: action.target.groupName } : { grantee: action.target.principal };
      const who = action.target.kind === "group" ? action.target.groupName : (picked?.label ?? "");
      grant.mutate({ ...target, capabilities: action.capabilities, replace }, {
        onSuccess: () => { notify.success(t("toast.accessGranted")); setPicked(null); setQuery(""); setGroupName(""); },
        onError: (e) => onAddError(e, () => dispatchAdd(action, true), who, capNoun(action.capabilities[0]!)),
      });
      return;
    }
    setCapability(action.capability as PageRelation);
    addBuiltIn(action.capability as PageRelation, replace, () => dispatchAdd(action, true));
  };

  const addBuiltIn = (capability: PageRelation, replace = false, retry?: () => void) => {
    const again = retry ?? (() => addBuiltIn(capability, true));
    if (mode === "group") {
      if (!groupName) return;
      grant.mutate({ groupName, capability, replace }, {
        onSuccess: () => notify.success(t("toast.accessGranted")),
        onError: (e) => onAddError(e, again, groupName, capNoun(capability)),
      });
      setGroupName("");
      return;
    }
    if (!picked) return;
    const who = picked.label;
    grant.mutate({ grantee: picked.grantee, capability, replace }, {
      onSuccess: () => notify.success(t("toast.accessGranted")),
      onError: (e) => onAddError(e, again, who, capNoun(capability)),
    });
    setPicked(null);
    setQuery("");
  };

  const grants = access.data ?? [];
  // #523 / ADR-190 slice D: the server now resolves each user grantee's full name (override ?? OIDC
  // display_name) on the manage-gated grant list (slice A), so an un-customized member reads as their
  // name, not a sub — the #513 root fix. A departed / cross-tenant sub comes back null and falls back to
  // the sub, unchanged. (This supersedes the customized-only /members/identities lookup here.)
  const label = (g: { grantee: string; groupName?: string; displayName?: string | null }) => {
    if (g.groupName) return `${g.groupName} (${t("spaceMembers.group")})`;
    // #536 ⑥: an unresolvable group id is an ORPHAN (group gone at the IdP) — say so instead of
    // printing the hash; the row keeps its revoke (unreadable must not mean unremovable).
    if (g.grantee.startsWith("group:")) return `${t("spaceMembers.unknownGroup")} (${t("spaceMembers.group")})`;
    const sub = g.grantee.replace(/^user:/, "");
    return g.displayName || sub;
  };

  // #536 ①: ONE list. A built-in grant row and a custom-role assignment row are the same thing to
  // the person reading this screen — a principal wearing a role — so they render as one sorted set. The
  // two mechanisms stay underneath (each row's revoke goes to its own machinery); that is an
  // implementation fact, not a reason to split the screen. One sort rule: principal name, then badge.
  type MergedRow =
    | { kind: "grant"; key: string; badge: string; custom: false; label: string; managed?: boolean; grantee: string; capability: PageRelation; foldedCaps?: PageRelation[]; principal?: undefined }
    | { kind: "assignment"; key: string; badge: string; custom: true; label: string; managed?: boolean; assignmentId: string; principal: string; grantee?: undefined };
  // #553 / ADR-199 §2 (rev5 ruling): a principal holding BOTH the edit and comment built-in grants is
  // ONE editor — the pair folds into a single "editor" row whose revoke removes both arms. The word
  // "commenter" appears on no GRANT surface (#552 — the picker); a lone comment grant (an unfolded
  // arm) still wears the capability noun "commenter" as its ROW BADGE (the #529 pin keeps it).
  const foldedGrantees = foldedEditorGrantees(grants);
  const visibleGrants = grants.filter((g) => !(foldedGrantees.has(g.grantee) && g.capability === "comment"));
  const mergedRows: MergedRow[] = [
    ...visibleGrants.map((g) => ({
      kind: "grant" as const, key: `g:${g.grantee}:${g.capability}`, badge: capNoun(g.capability), custom: false as const,
      label: label(g), managed: g.managed, grantee: g.grantee, capability: g.capability,
      ...(foldedGrantees.has(g.grantee) && g.capability === "edit" ? { foldedCaps: ["edit", "comment"] as PageRelation[] } : {}),
    })),
    ...(roleAssignments.data ?? []).map((a) => ({
      kind: "assignment" as const, key: `a:${a.id}`, badge: a.roleName, custom: true as const,
      // #497 re-review N2: a mapping-owned assignment is read-only here too (ADR-183 §1) — the
      // badge below replaces its revoke exactly as it does for the builtin grant rows.
      label: rolePrincipalLabel(a), assignmentId: a.id, principal: a.principal, managed: a.managed,
    })),
  ].sort((x, y) => x.label.localeCompare(y.label) || x.badge.localeCompare(y.badge));

  return (
    <div className="max-w-[640px] p-6" data-testid="space-members">
      <h2 className="mt-0">{t("spaceMembers.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("spaceMembers.body")}</p>

      <FormRow className="mb-6">
        <Select
          value={mode}
          onChange={(v) => setMode(v as "user" | "group")}
          ariaLabel={t("spaceMembers.granteeType")}
          testId="space-grant-type"
          options={[
            { value: "user", label: t("spaceMembers.typeUser") },
            { value: "group", label: t("spaceMembers.typeGroup") },
          ]}
        />
        {mode === "group" ? (
          // #578 / ADR-201 rev3 OQ4: ONE control for both halves. The picker can only offer group
          // names somebody already carries, which is the one thing the mapping form could do that
          // this could not — you could declare "Engineering" before anyone from Engineering had ever
          // logged in. That capability moves here instead of keeping its own screen: pick a known
          // group, or type a name, and a typed name says it is unconfirmed rather than looking the
          // same as one the IdP has actually produced.
          <span className="flex flex-col gap-1">
            <Select
              value={(groups.data ?? []).includes(groupName) ? groupName : ""}
              onChange={(v) => setGroupName(v)}
              ariaLabel={t("spaceMembers.typeGroup")}
              testId="space-grant-group"
              options={[
                { value: "", label: t("spaceMembers.selectGroup") },
                ...((groups.data ?? []).map((g) => ({ value: g, label: g }))),
              ]}
            />
            <Input
              inputSize="sm"
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder={t("spaceMembers.groupNamePlaceholder")}
              aria-label={t("spaceMembers.groupNamePlaceholder")}
              data-testid="space-grant-group-name"
            />
            {groupName && !(groups.data ?? []).includes(groupName) && (
              <span className="text-[11px] text-fg-dim" data-testid="space-grant-group-unconfirmed">
                {t("spaceMembers.groupUnconfirmed")}
              </span>
            )}
          </span>
        ) : (
        <MemberSearchInput
          query={query}
          onQueryChange={setQuery}
          picked={picked}
          onPick={(c) => { setPicked(c ? { grantee: `user:${c.sub}`, label: c.displayName || c.sub } : null); if (c) setQuery(""); }}
          candidates={candidates.data ?? []}
          placeholder={t("spaceMembers.addPlaceholder")}
          ariaLabel={t("spaceMembers.addPlaceholder")}
          inputTestId="space-grant-input"
          listTestId="space-grant-candidates"
          itemTestId="space-grant-candidate"
        />
        )}
        {/* #536 / ADR-188 §6: built-in roles and custom roles are ONE list. They remain two mechanisms
            underneath (a built-in is a capability grant, a custom role expands its bundle), but that is an
            implementation fact and was never a reason to make someone choose which of two controls to use.
            The value carries the kind so the click below dispatches without guessing. */}
        <Select
          value={pick}
          onChange={setPick}
          ariaLabel={t("spaceMembers.capability")}
          testId="space-grant-capability"
          options={[
            ...GRANTABLE.map((c) => ({ value: `builtin:${c}`, label: capNoun(c) })),
            ...customRoles.map((r) => ({ value: `role:${r.id}`, label: r.name })),
          ]}
        />
        <Button variant="primary" disabled={(mode === "group" ? !groupName : !picked) || grant.isPending || assignRole.isPending} onClick={addUnified} data-testid="space-grant-add">{t("spaceMembers.add")}</Button>
      </FormRow>

      {/* #539: the list scrolls INSIDE a bounded box — the third instance of the same failure
          (#503 audit ledger, #521 patrol queue), so it takes the same 26rem box rather than a third
          bespoke treatment. The page keeps its own scroll; only this list scrolls.
          #536 ①: built-in grant rows and custom-role assignment rows are ONE list (the old
          space-grant-list / space-role-assign-list pair is gone). Row badges: a built-in wears the
          capability noun, a custom role its name (accent); each row's revoke reaches its own mechanism. */}
      <div className="flex max-h-[26rem] flex-col gap-1 overflow-y-auto rounded-md border border-border p-1" data-testid="space-member-list">
        {mergedRows.map((r) => (
          <div key={r.key} className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2" data-testid="space-member-item" data-kind={r.kind}>
            {r.custom ? (
              <span className="min-w-[52px] flex-none rounded-full border border-[var(--accent)] px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-[var(--accent)]">{r.badge}</span>
            ) : (
              <span className="min-w-[52px] flex-none rounded-full border border-border px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-fg-dim data-[cap=manage]:border-[var(--accent)] data-[cap=manage]:text-[var(--accent)]" data-cap={r.capability}>{r.badge}</span>
            )}
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{r.label}</span>
            {/* #497 (088): a mapping-conferred row is machine-managed (ADR-183 §1) — no revoke affordance
                here (the server 409s it anyway; this is the read-only-with-a-pointer rendering). It is
                removed by deleting the MAPPING in the group-mappings section below. */}
            {r.managed ? (
              <span className="flex-none rounded bg-panel-2 px-1.5 py-px text-[10px] uppercase tracking-wide text-fg-dim" data-testid="space-grant-managed" data-tip={t("spaceMembers.managedByMapping")}>{t("spaceMembers.managedBadge")}</span>
            ) : r.kind === "grant" ? (
              /* #504: red at rest; no confirm — a grant is re-grantable in one step (exception candidate) */
              <IconButton aria-label={t("spaceMembers.revoke")} data-testid="space-grant-revoke" variant="danger"
                onClick={() => {
                  // #553: a folded editor row revokes BOTH its arms — the noun revokes what the noun granted
                  // #553 (a): ONE request for a folded row. Two calls could stop halfway and leave
                  // the comment arm standing — "revoked, but they can still comment" is a leftover
                  // nobody goes looking for, so the server takes the whole set in one transaction.
                  const caps = revokeCapsForRow(r) as PageRelation[];
                  revoke.mutate(caps.length > 1 ? { grantee: r.grantee, capabilities: caps } : { grantee: r.grantee, capability: caps[0]! }, {
                    onSuccess: () => notify.success(t("toast.accessRevoked")),
                    onError: () => notify.error(t("toast.actionFailed")),
                  });
                }}>
                <X size={14} />
              </IconButton>
            ) : (
              /* #504: red at rest; no confirm — an unassignment is re-assignable in one step */
              <IconButton aria-label={t("spaceMembers.revoke")} data-testid="space-role-assign-revoke" variant="danger"
                onClick={() => unassignRole.mutate(r.assignmentId, {
                  onSuccess: () => notify.success(t("toast.accessRevoked")),
                  onError: () => notify.error(t("toast.actionFailed")),
                })}>
                <X size={14} />
              </IconButton>
            )}
          </div>
        ))}
        {mergedRows.length === 0 && <p className="text-sm text-fg-dim">{t("spaceMembers.empty")}</p>}
      </div>

      {/* #536 ②: the replacement confirm — adding over a different existing role swaps it. */}
      {/* #553 review: this asked "replace their role?" over a RED button labelled Delete, because
          omitting confirmLabel/tone inherits ConfirmDialog's delete defaults. Nothing is deleted here —
          a role is swapped. The button says what happens, and the red is kept for the ONE case that
          really takes something away: demoting a manager, who loses every management capability on
          this space. An ordinary swap is reversible in a click, which #504 says is not red. */}
      <ConfirmDialog
        open={pendingAdd !== null}
        message={pendingAdd
          ? t(pendingAdd.manager ? "spaceMembers.managerReplaceConfirm" : "spaceMembers.replaceConfirm",
              { who: pendingAdd.who, current: pendingAdd.current, next: pendingAdd.next })
          : ""}
        confirmLabel={t("spaceMembers.replaceAction")}
        tone={pendingAdd?.manager ? "danger" : "primary"}
        confirmTestId="space-role-replace-confirm"
        onClose={() => setPendingAdd(null)}
        onConfirm={() => { pendingAdd?.run(); setPendingAdd(null); }}
      />

      {/* #514 / ADR-188 §8: a mapping onto a SPACE role is this space's configuration, so it lives here
          rather than on the tenant Roles tab (which kept a space picker only tenant admins could reach).
          The server already gated it per resource — creating needs `manage` on this space, and the
          filtered list answers to the same authority. */}
      {/* #497 re-review N4: builtin mappings need NO custom role — gating the section on
          customRoles.length made it unreachable for exactly the tenants #497 opened it to. */}

      {/* #100 / ADR-029: comment AUDIENCE toggles — who may comment on this space's pages. A resource
          setting (space#comment_open), separate from the per-member grants above. Default OFF.
          #529 (honest audience UI): the toggles are only ONE of three OR'd comment routes
          (per-principal grant / edit subsumption / audience) — so the BASELINE the toggles cannot touch
          is shown above them, each toggle wears its DELTA (who it adds / removes), and a one-line
          effective summary tracks the state. Display-only: the server's 3-way OR stays the fortress. */}
      <div className="mt-8 border-t border-border pt-4" data-testid="comment-open">
        <h3 className="mt-0 text-sm font-medium">{t("spaceMembers.commentAudienceTitle")}</h3>
        <p className="mt-0 mb-3 text-sm text-fg-dim">{t("spaceMembers.commentAudienceBody")}</p>
        <div className="mb-3 rounded-md border border-border bg-panel p-2.5 text-sm" data-testid="comment-baseline">
          {/* #552: the "individually granted commenters: N" line is gone with the built-in role. The
              editors-always baseline stays — it is the route no toggle can touch (#529). */}
          <p className="m-0">{t("spaceMembers.commentBaselineEditors")}</p>
        </div>
        {([
          { key: "guests" as const, label: t("spaceMembers.commentGuests"), testId: "comment-open-guests", onKey: "spaceMembers.commentGuestsOn", offKey: "spaceMembers.commentGuestsOff" },
          { key: "members" as const, label: t("spaceMembers.commentMembers"), testId: "comment-open-members", onKey: "spaceMembers.commentMembersOn", offKey: "spaceMembers.commentMembersOff" },
        ]).map(({ key, label: lbl, testId, onKey, offKey }) => {
          const on = !!commentOpen.data?.[key];
          return (
            <label key={key} className="mb-2 flex items-start gap-2 text-sm">
              {/* #389 / ADR-146: the hand-rolled role=switch button -> the shared DS Switch. data-on kept
                  for existing assertions. */}
              <Switch checked={on} testId={testId} data-on={on}
                disabled={commentOpen.isLoading || setCommentOpen.isPending}
                onChange={(v) => toggleCommentOpen(key, v)} />
              <span>
                {lbl}
                {/* the DELTA: what this switch position actually changes, said in people terms */}
                <span className="block text-xs text-fg-dim" data-testid={`${testId}-delta`}>{t(on ? onKey : offKey)}</span>
              </span>
            </label>
          );
        })}
        <p className="mb-0 mt-3 text-sm" data-testid="comment-effective-summary">
          {commentAudienceSummary(t, {
            members: !!commentOpen.data?.members,
            guests: !!commentOpen.data?.guests,
          })}
        </p>
      </div>
    </div>
  );
}
