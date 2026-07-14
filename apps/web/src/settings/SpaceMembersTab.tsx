import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Input } from "../ui/Input";
import {
  useSpaceAccess, useGrantSpaceAccess, useRevokeSpaceAccess, useMemberCandidates, useTenantGroups,
  useCommentOpen, useSetCommentOpen,
  type PageRelation,
} from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Select } from "../ui/Select";
import { notify } from "../ui/toast";
import { Switch } from "../ui/Switch";

interface SpaceCtx { spaceId: string; name: string }
// #330 / ADR-141: `moderate` → space#moderator (revert/freeze/patrol + edit; grants/settings stay manage-only).
const CAPS: PageRelation[] = ["view", "edit", "moderate", "manage"];

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
  const candidates = useMemberCandidates(spaceId, picked ? "" : query);
  const groups = useTenantGroups(spaceId, mode === "group");

  const add = () => {
    if (mode === "group") {
      if (!groupName) return;
      grant.mutate({ groupName, capability }, {
        onSuccess: () => notify.success(t("toast.accessGranted")),
        onError: () => notify.error(t("toast.actionFailed")),
      });
      setGroupName("");
      return;
    }
    if (!picked) return;
    grant.mutate({ grantee: picked.grantee, capability }, {
      onSuccess: () => notify.success(t("toast.accessGranted")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
    setPicked(null);
    setQuery("");
  };

  const grants = (access.data ?? []).slice().sort((a, b) => CAPS.indexOf(b.capability) - CAPS.indexOf(a.capability));
  const label = (g: { grantee: string; groupName?: string }) =>
    g.groupName ? `${g.groupName} (${t("spaceMembers.group")})`
    : g.grantee.startsWith("group:") ? `${g.grantee.replace(/^group:/, "").replace(/#member$/, "")} (${t("spaceMembers.group")})`
    : g.grantee.replace(/^user:/, "");

  return (
    <div className="max-w-[640px] p-6" data-testid="space-members">
      <h2 className="mt-0">{t("spaceMembers.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("spaceMembers.body")}</p>

      <div className="mb-6 flex items-start gap-2">
        <Select
          value={mode}
          onChange={(v) => setMode(v as "user" | "group")}
          ariaLabel={t("spaceMembers.granteeType")}
          testId="space-grant-type"
          size="sm"
          options={[
            { value: "user", label: t("spaceMembers.typeUser") },
            { value: "group", label: t("spaceMembers.typeGroup") },
          ]}
        />
        {mode === "group" ? (
          <Select
            value={groupName}
            onChange={(v) => setGroupName(v)}
            ariaLabel={t("spaceMembers.typeGroup")}
            testId="space-grant-group"
            size="sm"
            options={[
              { value: "", label: t("spaceMembers.selectGroup") },
              ...((groups.data ?? []).map((g) => ({ value: g, label: g }))),
            ]}
          />
        ) : (
        <div className="relative min-w-0 flex-1">
          <Input
            className="w-full"
            data-testid="space-grant-input"
            value={picked ? picked.label : query}
            placeholder={t("spaceMembers.addPlaceholder")}
            aria-label={t("spaceMembers.addPlaceholder")}
            onChange={(e) => { setPicked(null); setQuery(e.target.value); }}
          />
          {!picked && query.trim().length > 0 && (candidates.data?.length ?? 0) > 0 && (
            <ul className="absolute left-0 right-0 top-[calc(100%+2px)] z-20 m-0 max-h-60 list-none overflow-y-auto rounded-md border border-border bg-panel p-1 shadow-md" data-testid="space-grant-candidates">
              {candidates.data!.map((c) => (
                <li key={c.sub}>
                  <button type="button" className="flex w-full cursor-pointer flex-col gap-px rounded-sm border-none bg-transparent px-2 py-1.5 text-left text-foreground hover:bg-panel-2" data-testid="space-grant-candidate"
                    onClick={() => { setPicked({ grantee: `user:${c.sub}`, label: c.displayName || c.sub }); setQuery(""); }}>
                    <span className="text-sm">{c.displayName || c.sub}</span>
                    {c.displayName && <span className="text-[11px] text-fg-dim">{c.sub}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        )}
        <Select
          value={capability}
          onChange={(v) => setCapability(v as PageRelation)}
          ariaLabel={t("spaceMembers.capability")}
          testId="space-grant-capability"
          size="sm"
          options={CAPS.map((c) => ({ value: c, label: t(`spaceMembers.${c}`) }))}
        />
        <Button variant="primary" size="sm" disabled={(mode === "group" ? !groupName : !picked) || grant.isPending} onClick={add} data-testid="space-grant-add">{t("spaceMembers.add")}</Button>
      </div>

      <div className="flex flex-col gap-1" data-testid="space-grant-list">
        {grants.map((g) => (
          <div key={`${g.grantee}:${g.capability}`} className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2" data-testid="space-grant-item">
            <span className="min-w-[52px] flex-none rounded-full border border-border px-2 py-px text-center text-[11px] uppercase tracking-[0.03em] text-fg-dim data-[cap=manage]:border-[var(--accent)] data-[cap=manage]:text-[var(--accent)]" data-cap={g.capability}>{t(`spaceMembers.${g.capability}`)}</span>
            <span className="min-w-0 flex-1 text-sm [overflow-wrap:anywhere]">{label(g)}</span>
            <IconButton aria-label={t("spaceMembers.revoke")} data-testid="space-grant-revoke" className="hover:text-destructive"
              onClick={() => revoke.mutate({ grantee: g.grantee, capability: g.capability }, {
                onSuccess: () => notify.success(t("toast.accessRevoked")),
                onError: () => notify.error(t("toast.actionFailed")),
              })}>
              <X size={14} />
            </IconButton>
          </div>
        ))}
        {grants.length === 0 && <p className="text-sm text-fg-dim">{t("spaceMembers.empty")}</p>}
      </div>

      {/* #100 / ADR-029: comment AUDIENCE toggles — who may comment on this space's pages. A resource
          setting (space#comment_open), separate from the per-member grants above. Default OFF. */}
      <div className="mt-8 border-t border-border pt-4" data-testid="comment-open">
        <h3 className="mt-0 text-sm font-medium">{t("spaceMembers.commentAudienceTitle")}</h3>
        <p className="mt-0 mb-3 text-sm text-fg-dim">{t("spaceMembers.commentAudienceBody")}</p>
        {([
          { key: "guests" as const, label: t("spaceMembers.commentGuests"), testId: "comment-open-guests" },
          { key: "members" as const, label: t("spaceMembers.commentMembers"), testId: "comment-open-members" },
        ]).map(({ key, label: lbl, testId }) => {
          const on = !!commentOpen.data?.[key];
          return (
            <label key={key} className="mb-2 flex items-center gap-2 text-sm">
              {/* #389 / ADR-146: the hand-rolled role=switch button -> the shared DS Switch. data-on kept
                  for existing assertions. */}
              <Switch checked={on} testId={testId} data-on={on}
                disabled={commentOpen.isLoading || setCommentOpen.isPending}
                onChange={(v) => toggleCommentOpen(key, v)} />
              <span>{lbl}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
