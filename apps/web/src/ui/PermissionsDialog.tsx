import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageAccess, useGrantAccess, useRevokeAccess, usePage, useTenantGroups, type PageRelation } from "../data/queries";
import { notify } from "./toast";
import { Select } from "./Select";
import { Button, IconButton } from "./Button";
import { Input } from "./Input";
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
  const [mode, setMode] = useState<"user" | "group">("user");
  const [sub, setSub] = useState("");
  const [groupName, setGroupName] = useState("");
  const [relation, setRelation] = useState<PageRelation>("view");

  const add = () => {
    if (mode === "group") {
      if (!groupName) return;
      grant.mutate({ groupName, relation }, {
        onSuccess: () => notify.success(t("toast.accessGranted")),
        onError: () => notify.error(t("toast.actionFailed")),
      });
      return;
    }
    const s = sub.trim();
    if (!s) return;
    grant.mutate({ grantee: `user:${s}`, relation }, {
      onSuccess: () => notify.success(t("toast.accessGranted")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
    setSub("");
  };
  // Prefer the server-resolved group name (groupFgaId is one-way); fall back to the raw id.
  const label = (g: { grantee: string; groupName?: string }) =>
    g.groupName ? `${g.groupName} (${t("permissions.group")})`
    : g.grantee.startsWith("group:") ? `${g.grantee.replace(/^group:/, "").replace(/#member$/, "")} (${t("permissions.group")})`
    : g.grantee.replace(/^user:/, "");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="permissions-dialog" className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("permissions.title")}</DialogTitle>
          <DialogDescription>{t("permissions.body")}</DialogDescription>
        </DialogHeader>

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
            <Input inputSize="sm" className="min-w-0 flex-1" data-testid="grant-sub" aria-label={t("permissions.member")} placeholder={t("permissions.memberPlaceholder")} value={sub} onChange={(e) => setSub(e.target.value)} />
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

        <DialogFooter className="mt-4">
          <Button variant="default" type="button" onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
