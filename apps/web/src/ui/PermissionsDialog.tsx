import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageAccess, useGrantAccess, useRevokeAccess, usePageRestrictions, useRestrict, useUnrestrict, usePagePrivate, useSetPrivate, usePagePublic, useSetPublic, usePublicSurface, usePage, usePublished, useTenantGroups, useShareLinks, useSetFrozen, usePageMemberCandidates, type PageRelation } from "../data/queries";
import { MemberSearchInput } from "./MemberSearchInput";
import { ConfirmDialog } from "./dialogs";
import { notify } from "./toast";
import { Select } from "./Select";
import { Button, IconButton } from "./Button";
import { Input } from "./Input";
import { Switch } from "./Switch";
import { RadioGroup } from "./RadioGroup";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";

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
  const revoke = useRevokeAccess(pageId);
  const { data: restrictions } = usePageRestrictions(pageId, open); // #109
  const restrict = useRestrict(pageId);
  const unrestrict = useUnrestrict(pageId);
  const { data: isPrivate } = usePagePrivate(pageId, open); // #109 / ADR-098
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
  const [mode, setMode] = useState<"user" | "group">("user");
  const [sub, setSub] = useState("");
  const [groupName, setGroupName] = useState("");
  const [relation, setRelation] = useState<PageRelation>("view");
  const [restrictSub, setRestrictSub] = useState("");
  // #416 / ADR-161: member typeahead (page#manage-gated endpoint). A pick fills the grantee; RAW input
  // stays valid (the picker assists — a pasted sub still works, as before).
  const [pickedGrant, setPickedGrant] = useState<{ grantee: string; label: string } | null>(null);
  const [pickedRestrict, setPickedRestrict] = useState<{ grantee: string; label: string } | null>(null);
  const grantCandidates = usePageMemberCandidates(open && mode === "user" && !pickedGrant ? pageId : null, sub);
  const restrictCandidates = usePageMemberCandidates(open && !pickedRestrict ? pageId : null, restrictSub);

  const addRestrict = () => {
    const principal = pickedRestrict?.grantee ?? (restrictSub.trim() ? `user:${restrictSub.trim()}` : null);
    if (!principal) return;
    restrict.mutate({ principal }, {
      onSuccess: () => { notify.success(t("toast.saved")); setRestrictSub(""); setPickedRestrict(null); },
      onError: () => notify.error(t("toast.actionFailed")),
    });
  };

  const add = () => {
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
      <DialogContent data-testid="permissions-dialog" className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("permissions.title")}</DialogTitle>
          <DialogDescription>{t("permissions.body")}</DialogDescription>
        </DialogHeader>

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

        {/* #329 / ADR-139: FREEZE (staged edit lock) — off / guests-only / everyone-below-manager.
            Explicit radios (the #389 direction: no highlight-square selection). Managers always edit;
            commenting stays open for principals holding view (edit-independent path). */}
        <div className="mt-2 rounded-md border border-border p-2" data-testid="freeze-row">
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
              placeholder={t("permissions.memberPlaceholder")}
              ariaLabel={t("permissions.member")}
              inputTestId="grant-sub"
              listTestId="grant-candidates"
              itemTestId="grant-candidate"
            />
          )}
          <Select
            value={relation}
            onChange={(v) => setRelation(v as PageRelation)}
            ariaLabel={t("permissions.relation")}
            testId="grant-relation"
            size="sm"
            options={[
              { value: "view", label: t("permissions.view") },
              { value: "comment", label: t("permissions.comment") }, // #100: per-member comment grant
              { value: "edit", label: t("permissions.edit") },
              { value: "moderate", label: t("permissions.moderate") }, // #330: per-page moderator (freeze/revert/patrol; not manage)
              { value: "manage", label: t("permissions.manage") },
            ]}
          />
          <Button variant="primary" size="sm" data-testid="grant-add" disabled={grant.isPending} onClick={add}>{t("permissions.add")}</Button>
        </div>

        <div className="mt-3 flex max-h-[55vh] flex-col gap-2 overflow-y-auto" data-testid="grant-list">
          {(grants ?? []).map((g) => (
            <div key={`${g.grantee}:${g.relation}`} className="flex items-center gap-2" data-testid="grant-item">
              <span className="whitespace-nowrap text-xs text-fg-dim">{g.relation}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label(g)}</span>
              <IconButton aria-label={t("permissions.revoke")} data-testid="grant-revoke" className="text-destructive hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] hover:text-destructive" onClick={() => revoke.mutate({ grantee: g.grantee, relation: g.relation }, {
                onSuccess: () => notify.success(t("toast.accessRevoked")),
                onError: () => notify.error(t("toast.actionFailed")),
              })}>×</IconButton>
            </div>
          ))}
          {(grants?.length ?? 0) === 0 && <p className="m-0 text-xs text-fg-dim">{t("permissions.empty")}</p>}
        </div>

        {/* #109 / ADR-072 monotonic deny: restrict a principal from this page — they can't view it even
            as a space viewer (the page 404s for them). Deny wins over every grant. */}
        <div className="mt-4 border-t border-border pt-3">
          <p className="m-0 mb-2 text-xs font-medium text-fg-dim">{t("permissions.restrictTitle")}</p>
          <div className="flex items-center gap-2">
            {/* restrict stays USER-only by design (#416: group/share_link restrictees are out of scope). */}
            <MemberSearchInput
              query={restrictSub}
              onQueryChange={setRestrictSub}
              picked={pickedRestrict}
              onPick={(c) => setPickedRestrict(c ? { grantee: `user:${c.sub}`, label: c.displayName || c.sub } : null)}
              candidates={restrictCandidates.data ?? []}
              placeholder={t("permissions.restrictPlaceholder")}
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
                })}>×</IconButton>
              </div>
            ))}
          </div>
        </div>

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
