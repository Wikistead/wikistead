import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePageAccess, useGrantAccess, useRevokeAccess, type PageRelation } from "../data/queries";
import { notify } from "./toast";
import { Select } from "./Select";
import { Button, IconButton } from "./Button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "../components/ui/dialog";

// Per-page permission management (Phase 4c). Shown only to managers (the open page's
// canManage); the server re-checks `manage` on every access call. Granting view/edit
// is also how you INVITE someone to an unpublished (draft) page — a draft is private
// to the people listed here until it is published.
export function PermissionsDialog({ pageId, open, onClose }: { pageId: string; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const { data: grants } = usePageAccess(pageId, open);
  const grant = useGrantAccess(pageId);
  const revoke = useRevokeAccess(pageId);
  const [sub, setSub] = useState("");
  const [relation, setRelation] = useState<PageRelation>("view");

  const add = () => {
    const s = sub.trim();
    if (!s) return;
    grant.mutate({ grantee: `user:${s}`, relation }, {
      onSuccess: () => notify.success(t("toast.accessGranted")),
      onError: () => notify.error(t("toast.actionFailed")),
    });
    setSub("");
  };
  const label = (g: string) => g.startsWith("group:") ? `${g.replace(/^group:/, "").replace(/#member$/, "")} (${t("permissions.group")})` : g.replace(/^user:/, "");

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="permissions-dialog" className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{t("permissions.title")}</DialogTitle>
          <DialogDescription>{t("permissions.body")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <input className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground outline-none focus:border-[var(--accent)]" data-testid="grant-sub" aria-label={t("permissions.member")} placeholder={t("permissions.memberPlaceholder")} value={sub} onChange={(e) => setSub(e.target.value)} />
          <Select
            value={relation}
            onChange={(v) => setRelation(v as PageRelation)}
            ariaLabel={t("permissions.relation")}
            testId="grant-relation"
            size="sm"
            options={[
              { value: "view", label: t("permissions.view") },
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
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label(g.grantee)}</span>
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
