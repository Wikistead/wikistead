import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
import { useShareLinks, useCreateShareLink, useRevokeShareLink } from "../data/queries";
import { notify } from "./toast";
import { Select } from "./Select";
import { Button, IconButton } from "./Button";
import { Input } from "./Input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";

const EXPIRY_OPTIONS: { key: string; seconds: number | null }[] = [
  { key: "shareDialog.never", seconds: null },
  { key: "shareDialog.oneHour", seconds: 3600 },
  { key: "shareDialog.oneDay", seconds: 86400 },
  { key: "shareDialog.sevenDays", seconds: 604800 },
];

// Member-facing share UI: create page links (view/edit, optional expiry), copy
// the URL, and revoke. The URL carries only the unguessable link id; the guest
// exchanges it for a short-lived token at the public landing endpoint.
export function ShareDialog({ pageId, onClose }: { pageId: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  const open = pageId !== null;
  const links = useShareLinks(pageId ?? "", open);
  const create = useCreateShareLink();
  const revoke = useRevokeShareLink();

  const [capability, setCapability] = useState<"view" | "edit">("view");
  const [expiry, setExpiry] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const linkUrl = (id: string) => `${location.origin}/share/${id}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent data-testid="share-dialog" className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{t("shareDialog.title")}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Select
            value={capability}
            onChange={(v) => setCapability(v as "view" | "edit")}
            ariaLabel={t("shareDialog.capability")}
            testId="share-capability"
            size="sm"
            options={[
              { value: "view", label: t("shareDialog.canView") },
              { value: "edit", label: t("shareDialog.canEdit") },
            ]}
          />
          <Select
            value={String(expiry)}
            onChange={(v) => setExpiry(v === "null" ? null : Number(v))}
            ariaLabel={t("shareDialog.expiry")}
            size="sm"
            options={EXPIRY_OPTIONS.map((o) => ({ value: String(o.seconds), label: t(o.key) }))}
          />
          <Button
            variant="primary"
            size="sm"
            data-testid="create-link"
            disabled={pageId === null || create.isPending}
            onClick={() => pageId && create.mutate({ pageId, capability, expiresInSeconds: expiry }, {
              onSuccess: () => notify.success(t("toast.linkCreated")),
              onError: () => notify.error(t("toast.actionFailed")),
            })}
          >
            {t("shareDialog.create")}
          </Button>
        </div>

        <div className="mt-3 flex max-h-[55vh] flex-col gap-2 overflow-y-auto" data-testid="link-list">
          {links.isLoading ? (
            <div className="text-sm text-fg-dim">{t("common.loading")}</div>
          ) : (links.data?.length ?? 0) === 0 ? (
            <div className="text-sm text-fg-dim">{t("shareDialog.noLinks")}</div>
          ) : (
            links.data!.map((l) => (
              <div key={l.id} className="flex items-center gap-2">
                <span className="whitespace-nowrap text-xs text-fg-dim">
                  {l.capability === "edit" ? t("shareDialog.edit") : t("shareDialog.view")}
                  {l.expiresAt ? ` · ${t("shareDialog.expires", { when: new Date(l.expiresAt).toLocaleString() })}` : ` · ${t("shareDialog.neverExpires")}`}
                </span>
                <Input inputSize="sm" className="min-w-0 flex-1 text-xs" readOnly value={linkUrl(l.id)} aria-label={t("shareDialog.shareUrl")} />
                <IconButton
                  aria-label={t("shareDialog.copyUrl")}
                  title={t("shareDialog.copyUrl")}
                  onClick={() => {
                    navigator.clipboard?.writeText(linkUrl(l.id));
                    setCopied(l.id);
                    notify.success(t("toast.copied"));
                  }}
                >
                  <Copy size={14} />
                </IconButton>
                <IconButton
                  aria-label={t("shareDialog.revoke")}
                  title={t("shareDialog.revoke")}
                  data-testid="revoke-link"
                  className="text-destructive hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] hover:text-destructive"
                  onClick={() => pageId && revoke.mutate({ id: l.id, pageId }, {
                    onSuccess: () => notify.success(t("toast.linkRevoked")),
                    onError: () => notify.error(t("toast.actionFailed")),
                  })}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))
          )}
        </div>
        {copied && <div className="mt-1 text-xs text-fg-dim">{t("shareDialog.copied")}</div>}

        <DialogFooter className="mt-4">
          <Button variant="default" type="button" onClick={onClose}>
            {t("shareDialog.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
