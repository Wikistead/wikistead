import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageAccess, useGrantAccess, useRevokeAccess, usePageRestrictions, useRestrict, useUnrestrict, usePagePrivate, useSetPrivate, usePagePublic, useSetPublic, usePublicSurface, usePage, usePublished, useTenantGroups, useShareLinks, useSetFrozen, usePageMemberCandidates, usePageCommentAudience, useSetPageCommentAudience, usePageAssignableRoles, useRoleAssignments, useAssignRole, useUnassignRole, type PageRelation } from "../data/queries";
import { resolveGrantDispatch } from "../settings/grant-dispatch";
import { notifyRevokeOutcome, notifyRevokeError } from "../settings/revoke-feedback";
import { MemberSearchInput } from "./MemberSearchInput";
import { RoleTip } from "./RoleTip";
import { capNoun, effectiveCaps } from "../settings/role-nouns";
import { ConfirmDialog } from "./dialogs";
import { notify } from "./toast";
import { Select } from "./Select";
import { Button, IconButton } from "./Button";
import { Input } from "./Input";
import { Switch } from "./Switch";
import { RadioGroup } from "./RadioGroup";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { X } from "lucide-react"; // #544: icon component, not a text glyph

type TabKey = "access" | "restrictions" | "advanced";

// Per-page permission management (Phase 4c). Shown only to managers (the open page's
// canManage); the server re-checks `manage` on every access call. Granting view/edit
// is also how you INVITE someone to an unpublished (draft) page — a draft is private
// to the people listed here until it is published.
export function PermissionsDialog({ pageId, open, onClose }: { pageId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: grants } = usePageAccess(pageId, open);
  const { data: page } = usePage(pageId);
  const { data: groups } = useTenantGroups(page?.spaceId ?? "", open && !!page?.spaceId);
  const grant = useGrantAccess(pageId);
  const assignable = usePageAssignableRoles(pageId, open);
  const pageAssignments = useRoleAssignments("page", pageId, open);
  // #586 / ADR-203 §4: a custom role IS its capability list, and the assignment list carries only the
  // role's id and name — so the tooltip joins against the definitions this dialog already holds. The
  // join is on the payload the ADR-202 endpoint returns for THIS page, which is the §3 ruling in
  // practice: what the roles in front of you do, never the tenant's whole vocabulary.
  const roleCapsById = new Map((assignable.data?.custom ?? []).map((r) => [r.id, r.capabilities as readonly string[]]));
  const assignRole = useAssignRole();
  const unassignRole = useUnassignRole();
  const revoke = useRevokeAccess(pageId);
  const { data: restrictions } = usePageRestrictions(pageId, open); // #109
  const restrict = useRestrict(pageId);
  const unrestrict = useUnrestrict(pageId);
  const { data: isPrivate } = usePagePrivate(pageId, open); // #109 / ADR-098
  const commentAudience = usePageCommentAudience(pageId, open); // #399 / ADR-158 §1
  const setCommentAudience = useSetPageCommentAudience(pageId);
  const setPrivate = useSetPrivate(pageId);
  // #109 Fix A (comment 768): making a page private REVOKES its share links — warn (with the count) first.
  const { data: shareLinks } = useShareLinks({ type: "page", id: pageId }, open);
  const activeLinks = shareLinks?.length ?? 0;
  const [confirmPrivate, setConfirmPrivate] = useState(false);
  const applyPrivate = (v: boolean) => setPrivate.mutate(v, {
    onSuccess: () => notify.success(t("toast.saved")),
    onError: () => notify.error(t("toast.actionFailed")),
  });
  // #253 / ADR-113: the per-page PUBLIC toggle is offered ONLY when the tenant parent switch is ON (else the
  // whole public surface is hidden and toggling would be a no-op). public⊥private, so it's disabled while the
  // page is private. The server is the fortress (re-checks manage / parent-switch / published / private).
  const { data: surfaceOn } = usePublicSurface(open);
  const { data: publicState } = usePagePublic(pageId, open && !!surfaceOn);
  const isPublic = !!publicState?.public;
  // #253 review ④: the page is world-readable via a PUBLIC SPACE even though its OWN toggle reads OFF.
  const publicViaSpace = !!publicState?.effectivePublic && !isPublic;
  const { data: published } = usePublished(pageId);
  const isPublished = !!published?.publishedAt; // #253 review ①: only a published page can be made public
  const setPublic = useSetPublic(pageId);
  const applyPublic = (v: boolean) => setPublic.mutate(v, {
    onSuccess: () => notify.success(t("toast.saved")),
    // #253 review ②: the server returns a SPECIFIC reason (400 draft / 403 parent switch / 409 private);
    // surface it instead of the generic "something went wrong".
    onError: (err) => {
      const status = (err as { status?: number })?.status;
      const key = status === 400 ? "permissions.publicErrorDraft"
        : status === 403 ? "permissions.publicErrorSurface"
        : status === 409 ? "permissions.publicErrorPrivate"
        : "toast.actionFailed";
      notify.error(t(key));
    },
  });
  // #253 review ③: once public, expose the shareable /pub/<id> URL with a copy button.
  const publicUrl = `${window.location.origin}/pub/${pageId}`;
  const copyPublicUrl = async () => {
    try { await navigator.clipboard.writeText(publicUrl); notify.success(t("toast.copied")); }
    catch { notify.error(t("toast.actionFailed")); }
  };
  // #329 / ADR-139: FREEZE (staged edit lock). The level rides on the page payload; the server is the
  // fortress (manage-gated, and the FGA model cuts every edit path). Reversible, so no confirm dialog.
  const frozen = page?.frozen ?? null;
  const setFrozen = useSetFrozen(pageId);
  const applyFreeze = (level: "full" | "guests" | null) => setFrozen.mutate(level, {
    onSuccess: () => notify.success(t("toast.saved")),
    onError: () => notify.error(t("toast.actionFailed")),
  });
  // #460 / ADR-174: three tabs — who can reach the page (Access), who is kept out (Restrictions), and
  // the settings that are neither (Advanced). Grouping only; every endpoint and every semantic is
  // unchanged. The choice is remembered per page for the session, so re-opening the same page returns
  // to the tab you were working in while a different page starts at Access.
  const tabKey = `wks.permissions.tab.${pageId}`;
  const [tab, setTab] = useState<TabKey>("access");
  useEffect(() => {
    if (!open) return;
    const saved = sessionStorage.getItem(tabKey);
    setTab(saved === "restrictions" || saved === "advanced" ? saved : "access");
  }, [open, tabKey]);
  const selectTab = (v: string) => {
    const next: TabKey = v === "restrictions" || v === "advanced" ? v : "access";
    setTab(next);
    try { sessionStorage.setItem(tabKey, next); } catch { /* private mode / storage disabled */ }
  };
  const [mode, setMode] = useState<"user" | "group">("user");
  const [sub, setSub] = useState("");
  const [groupName, setGroupName] = useState("");
  // #582: the picker's value carries its MECHANISM as a prefix, so a custom role named `edit` can
  // never be mistaken for the capability (the #536 lesson, same encoding).
  const [pick, setPick] = useState<string>("builtin:view");
  const relation = (pick.startsWith("builtin:") ? pick.slice("builtin:".length) : "view") as PageRelation;
  const [restrictSub, setRestrictSub] = useState("");
  // #416 / ADR-161: member typeahead (page#manage-gated endpoint). A pick fills the grantee; RAW input
  // stays valid (the picker assists — a pasted sub still works, as before).
  const [pickedGrant, setPickedGrant] = useState<{ grantee: string; label: string } | null>(null);
  const [pickedRestrict, setPickedRestrict] = useState<{ grantee: string; label: string } | null>(null);
  // the typeahead only runs for the tab that shows it — the panel it belongs to is not even mounted
  // otherwise, so the request would be answering a question nobody asked
  const grantCandidates = usePageMemberCandidates(open && tab === "access" && mode === "user" && !pickedGrant ? pageId : null, sub);
  const restrictCandidates = usePageMemberCandidates(open && tab === "restrictions" && !pickedRestrict ? pageId : null, restrictSub);

  const addRestrict = () => {
    const principal = pickedRestrict?.grantee ?? (restrictSub.trim() ? `user:${restrictSub.trim()}` : null);
    if (!principal) return;
    restrict.mutate({ principal }, {
      onSuccess: () => { notify.success(t("toast.saved")); setRestrictSub(""); setPickedRestrict(null); },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  const add = () => {
    // #582: the DECISION is the shared pure function the space screen uses — `noComposite` because the
    // page grant route takes ONE relation per call (ADR-199 keeps the editor noun at space scope).
    const action = resolveGrantDispatch({
      pick, mode, groupName,
      picked: pickedGrant ? { grantee: pickedGrant.grantee } : (sub.trim() ? { grantee: `user:${sub.trim()}` } : null),
      noComposite: true,
    });
    if (action.path === "assign") {
      assignRole.mutate(
        { roleId: action.roleId, resourceType: "page", resourceId: pageId,
          ...(action.target.kind === "group" ? { groupName: action.target.groupName } : { principal: action.target.principal }) },
        { onSuccess: () => { notify.success(t("toast.accessGranted")); setSub(""); setPickedGrant(null); },
          onError: () => notify.error(t("toast.actionFailed")) },
      );
      return;
    }
    if (mode === "group") {
      if (!groupName) return;
      grant.mutate({ groupName, relation }, {
        onSuccess: () => notify.success(t("toast.accessGranted")),
        onError: () => notify.error(t("toast.actionFailed")),
      });
      return;
    }
    const grantee = pickedGrant?.grantee ?? (sub.trim() ? `user:${sub.trim()}` : null);
    if (!grantee) return;
    grant.mutate({ grantee, relation }, {
      onSuccess: () => notify.success(t("toast.accessGranted")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
    setSub("");
    setPickedGrant(null);
  };
  // Prefer the server-resolved group name (groupFgaId is one-way); fall back to the raw id.
  const label = (g: { grantee: string; groupName?: string }) =>
    g.groupName ? `${g.groupName} (${t("permissions.group")})`
    : g.grantee.startsWith("group:") ? `${g.grantee.replace(/^group:/, "").replace(/#member$/, "")} (${t("permissions.group")})`
    : g.grantee.replace(/^user:/, "");

  return (
    <>
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* #416the dialog is BOUNDED (max-h) as a flex column — header and footer stay put and
          everything between them is ONE scrolling body, so however many grants/restrictions/sections
          accumulate, the modal never outgrows the viewport and Close stays reachable. */}
      {/* #460 / ADR-174: wider on a large screen — the grant row (type / member / relation / add) had to
          wrap at 560px. The phone gutter is unchanged, and the dialog stays BOUNDED (#416): header,
          tab strip and footer are fixed and the ACTIVE PANEL scrolls, so Close is always reachable. */}
      {/* #460①: the height is FIXED, not just capped — with only `max-h` the dialog shrank to each
          tab's content, so switching tabs jumped its height. A constant height (85vh on a phone, a roomy
          560px on desktop, still clamped to 85vh on a short window) makes the flex-1 panel a stable box:
          short tabs leave breathing room at the bottom, the tall Access tab scrolls inside it, and the
          header / tab strip / footer never move between tabs. */}
      {/* #460without this, Radix auto-focuses the first tabbable — the active TabsTrigger
          and programmatic focus counts as :focus-visible, so a MOUSE open painted a focus ring on
          the Access tab. preventDefault alone strands focus outside the dialog (Radix then focuses
          NOTHING, measured: Tab goes dead), so focus the FocusScope container (e.target,
          tabIndex=-1) instead — no ring, and Tab still enters the dialog. */}
      <DialogContent data-testid="permissions-dialog" onOpenAutoFocus={(e) => { e.preventDefault(); (e.target as HTMLElement | null)?.focus?.(); }} className="flex h-[85vh] flex-col sm:h-[560px] sm:max-h-[85vh] sm:max-w-[560px] lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("permissions.title")}</DialogTitle>
          <DialogDescription>{t("permissions.body")}</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={selectTab}>
          {/* the three tabs are always present, including when a feature is off — a tab that appears and
              disappears with state teaches nobody where anything lives */}
          <TabsList aria-label={t("permissions.title")}>
            <TabsTrigger value="access" data-testid="permissions-tab-access">
              {t("permissions.tabAccess")}
              {/* the count is read at dialog level, so it is honest before its tab has ever been opened */}
              {(restrictions?.length ?? 0) > 0 && (
                <span className="rounded-full bg-panel-2 px-1.5 text-[11px] text-fg-dim" data-testid="permissions-restrict-count">{restrictions!.length}</span>
              )}
            </TabsTrigger>
            <TabsTrigger value="restrictions" data-testid="permissions-tab-restrictions">{t("permissions.tabRestrictions")}</TabsTrigger>
            <TabsTrigger value="advanced" data-testid="permissions-tab-advanced">{t("permissions.tabAdvanced")}</TabsTrigger>
          </TabsList>

        <TabsContent value="access" data-testid="permissions-panel-access">

        {/* #109 / ADR-098: PRIVATE (allowlist) toggle. Private cuts space inheritance — only the people
            listed below can view/edit — and strips public. Nested children do NOT inherit a parent's
            private in v1 (each page is private independently), noted to avoid a manager's false assumption. */}
        <label className="flex items-start gap-2 rounded-md border border-border p-2" data-testid="private-toggle-row">
          {/* #389 / ADR-146: on/off state → DS Switch (role=switch). The confirm-before-enable stays. */}
          <Switch className="mt-0.5" testId="private-toggle" checked={!!isPrivate}
            disabled={setPrivate.isPending}
            onChange={(checked) => {
              // Turning ON revokes the page's share links (#109 Fix A) — confirm first. Turning OFF is a plain toggle.
              if (checked) setConfirmPrivate(true);
              else applyPrivate(false);
            }} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">{t("permissions.privateTitle")}</span>
            <span className="block text-xs text-fg-dim">{isPrivate ? t("permissions.privateOnHint") : t("permissions.privateHint")}</span>
          </span>
        </label>

        {/* #253 / ADR-113: PUBLIC (anonymous) toggle — only offered when the tenant parent switch is ON.
            public⊥private → disabled while private. Only a PUBLISHED page can go public (server enforces 400). */}
        {surfaceOn && (
          <div className="mt-2 rounded-md border border-border p-2" data-testid="public-toggle-row">
            <label className="flex items-start gap-2">
              {/* #253 review ①: a DRAFT can't be public (server 400) — disable the toggle and say why, so it's
                  never a click-then-fail. private ⊥ public keeps it disabled while private. */}
              <Switch className="mt-0.5" testId="public-toggle" checked={isPublic}
                disabled={setPublic.isPending || !!isPrivate || !isPublished}
                onChange={applyPublic} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-foreground">{t("permissions.publicTitle")}</span>
                <span className="block text-xs text-fg-dim">
                  {isPrivate ? t("permissions.publicPrivateConflict")
                    : !isPublished ? t("permissions.publicDraftHint")
                    : isPublic ? t("permissions.publicOnHint")
                    : t("permissions.publicHint")}
                </span>
              </span>
            </label>
            {/* #253 review ③: the shareable public URL + copy, shown once the page is public. */}
            {isPublic && (
              <div className="mt-2 flex items-center gap-2" data-testid="public-url-row">
                <Input inputSize="sm" readOnly className="min-w-0 flex-1 font-mono text-xs" value={publicUrl} data-testid="public-url" aria-label={t("permissions.publicUrlLabel")} onFocus={(e) => e.currentTarget.select()} />
                <Button variant="default" size="sm" data-testid="public-url-copy" onClick={copyPublicUrl}>{t("permissions.copyUrl")}</Button>
              </div>
            )}
            {/* #253 review ④: reachable publicly via a public SPACE even though this page's own toggle is OFF. */}
            {publicViaSpace && (
              <p className="mt-2 text-xs text-fg-dim" data-testid="public-via-space">{t("permissions.publicViaSpace")}</p>
            )}
          </div>
        )}

        <p className="mt-3 text-xs font-medium text-fg-dim">{isPrivate ? t("permissions.allowlistTitle") : t("permissions.grantTitle")}</p>
        <div className="flex items-center gap-2">
          <Select
            value={mode}
            onChange={(v) => setMode(v as "user" | "group")}
            ariaLabel={t("permissions.granteeType")}
            testId="grant-type"
            size="sm"
            options={[
              { value: "user", label: t("permissions.typeUser") },
              { value: "group", label: t("permissions.typeGroup") },
            ]}
          />
          {mode === "group" ? (
            <Select
              value={groupName}
              onChange={(v) => setGroupName(v)}
              ariaLabel={t("permissions.typeGroup")}
              testId="grant-group"
              size="sm"
              options={[
                { value: "", label: t("permissions.selectGroup") },
                ...((groups ?? []).map((g) => ({ value: g, label: g }))),
              ]}
            />
          ) : (
            <MemberSearchInput
              inputSize="sm"
              query={sub}
              onQueryChange={setSub}
              picked={pickedGrant}
              onPick={(c) => setPickedGrant(c ? { grantee: `user:${c.sub}`, label: c.displayName || c.sub } : null)}
              candidates={grantCandidates.data ?? []}
              placeholder={t("common.memberSearch")}
              ariaLabel={t("permissions.member")}
              inputTestId="grant-sub"
              listTestId="grant-candidates"
              itemTestId="grant-candidate"
            />
          )}
          {/* #582 / ADR-202 §1: ONE picker. The five capabilities the dialog always offered, then the
              tenant's resource-scope custom roles — the same merged shape the space Members tab settled
              on in #536, so "give this person a role" does not mean two different things on two
              screens. The per-page `comment` grant stays in the list: ADR-199 severed comment from
              edit and #553's copy sends people here to grant it. */}
          <Select
            value={pick}
            onChange={setPick}
            ariaLabel={t("permissions.relation")}
            testId="grant-relation"
            size="sm"
            // #582 bounce: every entry in this list is a ROLE NAME, so every entry reads like one. The
            // built-ins wear the nouns the space screen has used since #445 (view→viewer, manage→manager)
            // instead of translated verbs, which is what made sit beside "kakunin-582" as if they
            // were different kinds of thing. Capability words still exist — on the surface that EDITS a
            // role definition, where they describe what the role may do.
            // #586 (review rejection): the option is the NAME, and hovering it says what that name confers.
            // Printing the capabilities under every label made the reader read the whole vocabulary before
            // picking one of nine. Same measured table as the rows (page scope here), so the answer cannot
            // differ between choosing and reading back.
            options={[
              ...(["view", "comment", "edit", "moderate", "manage"] as const).map((c) => ({
                value: `builtin:${c}`,
                label: capNoun(c),
                wrap: (l: React.ReactNode) => <RoleTip as="option" origin="role" scope="page" builtinCapability={c}>{l}</RoleTip>,
              })),
              ...(assignable.data?.custom ?? []).map((r) => ({
                value: `role:${r.id}`,
                label: r.name,
                wrap: (l: React.ReactNode) => <RoleTip as="option" origin="role" scope="page" roleCapabilities={r.capabilities}>{l}</RoleTip>,
              })),
            ]}
          />
          <Button variant="primary" size="sm" data-testid="grant-add" disabled={grant.isPending} onClick={add}>{t("permissions.add")}</Button>
        </div>

        {/* #416no per-list max-h — the single dialog-body scroll above replaces the nested scroller. */}
          <div className="mt-3 flex flex-col gap-2" data-testid="grant-list">
          {(grants ?? []).map((g) => (
            <div key={`${g.grantee}:${g.relation}`} className="flex items-center gap-2" data-testid="grant-item">
              {/* #582 bounce: the same badge a role-conferred row wears, with the same noun the picker
                  offered. It used to print the raw wire value as loose text beside a badge — one panel,
                  two designs for one idea. */}
              {/* #586 §1 (user ruling): the axis that matters is ROLE-DERIVED vs GRANTED INDIVIDUALLY
                  not built-in vs custom, which must never be split into separate lists. Two rows can now
                  read `commenter` legitimately (a role of that name, and a comment grant), so the colour
                  and the tooltip tell them apart instead of a rename. Colours are DS tokens. */}
              {/* #586 review ①: scope="page". A page grant writes ONE capability, so this row is a single arm
                  and its closure is the page table's, not the space NOUN's. Reading it out of the noun
                  table told a reader a page `edit` grant could comment; the store says it cannot. */}
              <RoleTip builtinCapability={g.relation} origin="grant" scope="page" testId="grant-origin">
                <span className="whitespace-nowrap rounded bg-panel-2 px-1 text-[10px] tracking-wide text-fg-dim" data-testid="grant-role-badge">{capNoun(g.relation)}</span>
              </RoleTip>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label(g)}</span>
              {/* #596: the server answers honestly now — success may carry "still covered by X"
                  (say it), and a no-op revoke refuses with 409 still_covered (name the coverage). */}
              <IconButton aria-label={t("permissions.revoke")} data-testid="grant-revoke" variant="danger" onClick={() => revoke.mutate({ grantee: g.grantee, relation: g.relation }, {
                onSuccess: (data) => notifyRevokeOutcome(t, data),
                onError: (err) => notifyRevokeError(t, err),
              })}><X size={14} /></IconButton>
            </div>
          ))}
          {/* #591 (B), settled 2026-08-02: the rows here stay CHIPS with an ×, and there is no per-row
              dropdown. #591 asked whether every surface should let you swap a role in place, and the two
              surfaces that got one have something this page does not: an exclusive role. At page scope a
              principal may legitimately hold `view` AND `edit` — nothing sweeps the other, and no
              equivalent of the space's sweepOtherSpaceRoles exists — so a dropdown here would assert an
              exclusivity the authorization model does not have. Changing that is an authz decision, not a
              UI one. The #579 review reached the same place from the other side: this dialog already
              offers ONE control to choose a role, which is what the user asked for.
              #582 / ADR-202 §1: role-conferred access is its OWN row kind, revoked by unassigning. Not
              because the × would corrupt the reference count — the page revoke already routes through
              unassignRoleInTx or leaves a covered tuple alone — but because it would report success,
              write an audit entry, fire a webhook, and change nothing in FGA. The user removes someone
              and they still have access. A row that offers the button that lies is the defect. */}
          {(pageAssignments.data ?? []).map((a) => (
            <div key={a.id} className="flex items-center gap-2" data-testid="grant-role-item">
              {/* no `uppercase`: shouting a tenant's role name back at them is changing it (kakunin-582
                  rendered as KAKUNIN-582). A role name is a proper noun on every surface. */}
              <RoleTip roleCapabilities={roleCapsById.get(a.roleId)} origin="role" scope="page" testId="grant-origin">
                <span className="whitespace-nowrap rounded border border-[var(--accent)] px-1 text-[10px] tracking-wide text-[var(--accent)]" data-testid="grant-role-badge">{a.roleName}</span>
              </RoleTip>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{a.groupName ? `${a.groupName} (${t("spaceMembers.group")})` : (a.displayName ?? a.principal.replace(/^user:/, ""))}</span>
              <IconButton aria-label={t("permissions.revoke")} data-testid="grant-role-revoke" variant="danger" onClick={() => unassignRole.mutate(a.id, {
                onSuccess: (data) => notifyRevokeOutcome(t, data),
                onError: (err) => notifyRevokeError(t, err),
              })}><X size={14} /></IconButton>
            </div>
          ))}
          {(grants?.length ?? 0) === 0 && (pageAssignments.data?.length ?? 0) === 0 && <p className="m-0 text-xs text-fg-dim">{t("permissions.empty")}</p>}
        </div>

        </TabsContent>

        <TabsContent value="restrictions" data-testid="permissions-panel-restrictions">
        {/* #109 / ADR-072 monotonic deny: restrict a principal from this page — they can't view it even
            as a space viewer (the page 404s for them). Deny wins over every grant. */}
        <div>
          <p className="m-0 mb-2 text-xs font-medium text-fg-dim">{t("permissions.restrictTitle")}</p>
          <div className="flex items-center gap-2">
            {/* restrict stays USER-only by design (#416: group/share_link restrictees are out of scope). */}
            <MemberSearchInput
              query={restrictSub}
              onQueryChange={setRestrictSub}
              picked={pickedRestrict}
              onPick={(c) => setPickedRestrict(c ? { grantee: `user:${c.sub}`, label: c.displayName || c.sub } : null)}
              candidates={restrictCandidates.data ?? []}
              placeholder={t("common.memberSearch")}
              ariaLabel={t("permissions.restrictTitle")}
              inputTestId="restrict-sub"
              listTestId="restrict-candidates"
              itemTestId="restrict-candidate"
            />
            <Button variant="default" size="sm" data-testid="restrict-add" disabled={restrict.isPending} onClick={addRestrict}>{t("permissions.restrictAdd")}</Button>
          </div>
          <div className="mt-2 flex flex-col gap-2" data-testid="restrict-list">
            {(restrictions ?? []).map((r) => (
              <div key={r.principal} className="flex items-center gap-2" data-testid="restrict-item">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{r.principal.replace(/^user:/, "").replace(/^group:/, "").replace(/#member$/, "")}</span>
                <IconButton aria-label={t("permissions.unrestrict")} data-testid="restrict-remove" onClick={() => unrestrict.mutate({ principal: r.principal }, {
                  onSuccess: () => notify.success(t("toast.saved")),
                  onError: () => notify.error(t("toast.actionFailed")),
                })}><X size={14} /></IconButton>
              </div>
            ))}
          </div>
        </div>

        </TabsContent>

        <TabsContent value="advanced" data-testid="permissions-panel-advanced">
        {/* #329 / ADR-139: FREEZE (staged edit lock) — off / guests-only / everyone-below-manager.
            Explicit radios (the #389 direction: no highlight-square selection). Managers always edit;
            commenting stays open for principals holding view (edit-independent path). */}
        <div className="rounded-md border border-border p-2" data-testid="freeze-row">
          <span className="block text-sm text-foreground">{t("permissions.freezeTitle")}</span>
          <span className="block text-xs text-fg-dim">
            {frozen === "full" ? t("permissions.freezeFullHint")
              : frozen === "guests" ? t("permissions.freezeGuestsHint")
              : t("permissions.freezeHint")}
          </span>
          {/* #389 / ADR-146: 3 short options → segmented radiogroup (DS component, arrow-key focus). */}
          <RadioGroup
            variant="segmented"
            className="mt-2"
            value={frozen === "full" ? "full" : frozen === "guests" ? "guests" : "off"}
            onChange={(v) => applyFreeze(v === "off" ? null : (v as "guests" | "full"))}
            ariaLabel={t("permissions.freezeTitle")}
            testId="freeze"
            disabled={setFrozen.isPending}
            options={(["off", "guests", "full"] as const).map((key) => ({
              value: key,
              label: t(`permissions.freeze${key === "off" ? "Off" : key === "guests" ? "Guests" : "Full"}`),
            }))}
          />
        </div>

        {/* #399 / ADR-158 §1: per-page comment-audience OVERRIDE — additive only (a page can open what
            the space keeps closed, never narrow it). Independent wildcards, mirrors SpaceMembersTab. */}
        <div className="mt-4 border-t border-border pt-3" data-testid="page-comment-audience">
          <p className="m-0 mb-1 text-xs font-medium text-fg-dim">{t("permissions.commentAudienceTitle")}</p>
          <p className="m-0 mb-2 text-xs text-fg-dim">{t("permissions.commentAudienceBody")}</p>
          {([
            { key: "guests" as const, label: t("permissions.commentGuests"), testId: "page-comment-guests" },
            { key: "members" as const, label: t("permissions.commentMembers"), testId: "page-comment-members" },
          ]).map(({ key, label: lbl, testId }) => {
            const on = !!commentAudience.data?.[key];
            return (
              <label key={key} className="mb-2 flex items-center gap-2 text-sm">
                <Switch checked={on} testId={testId} data-on={on}
                  disabled={commentAudience.isLoading || setCommentAudience.isPending}
                  onChange={(v) => setCommentAudience.mutate({ [key]: v }, {
                    onSuccess: () => notify.success(t("toast.saved")),
                    onError: () => notify.error(t("toast.actionFailed")),
                  })} />
                <span>{lbl}</span>
              </label>
            );
          })}
        </div>

        </TabsContent>
        </Tabs>

        <DialogFooter className="mt-4">
          <Button variant="default" type="button" onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {/* #109 Fix A (comment 768): confirm before privatising — it revokes the page's share links (one-way).
        Rendered as a SIBLING of the permissions Dialog (not nested) — nesting two Radix Dialog roots makes
        the inner content inherit the outer's context and the confirm click never applies the mutation. */}
    <ConfirmDialog
      stacked
      open={confirmPrivate}
      title={t("permissions.privateConfirmTitle")}
      message={t("permissions.privateConfirmBody", { count: activeLinks })}
      confirmLabel={t("permissions.privateConfirmAction")}
      confirmTestId="private-confirm"
      onClose={() => setConfirmPrivate(false)}
      onConfirm={() => { setConfirmPrivate(false); applyPrivate(true); }}
    />
    </>
  );
}
