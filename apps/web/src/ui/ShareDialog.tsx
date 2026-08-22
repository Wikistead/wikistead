import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadFailed } from "./LoadFailed";
import { Copy, Trash2 } from "lucide-react";
import { useShareLinks, useCreateShareLink, useRevokeShareLink } from "../data/queries";
import { notify } from "./toast";
import { Select } from "./Select";
import { Button, IconButton } from "./Button";
import { Input } from "./Input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { ConfirmDialog } from "./dialogs"; // #504: revoking kills the shared URL for everyone holding it

const EXPIRY_OPTIONS: { key: string; seconds: number | null }[] = [
  { key: "shareDialog.never", seconds: null },
  { key: "shareDialog.oneHour", seconds: 3600 },
  { key: "shareDialog.oneDay", seconds: 86400 },
  { key: "shareDialog.sevenDays", seconds: 604800 },
];

// Member-facing share UI: create page links (view/edit, optional expiry), copy
// the URL, and revoke. The URL carries only the unguessable link id; the guest
// exchanges it for a short-lived token at the public landing endpoint.
export function ShareDialog({ pageId, spaceId, onClose }: { pageId?: string | null; spaceId?: string | null; onClose: () => void }) {
  const { t } = useTranslation();
  // Exactly one of page/space identifies the shared resource. Space links are view-only and
  // open the WHOLE space (added pages auto-publish) — surfaced as a warning (#104 / ADR-038).
  const resource = pageId ? ({ type: "page", id: pageId } as const) : spaceId ? ({ type: "space", id: spaceId } as const) : null;
  const isSpace = !!spaceId;
  const open = resource !== null;
  const links = useShareLinks(resource, open);
  const create = useCreateShareLink();
  const revoke = useRevokeShareLink();

  const [capability, setCapability] = useState<"view" | "edit">("view");
  const [expiry, setExpiry] = useState<number | null>(null);
  const [password, setPassword] = useState(""); // #233: optional password (issuance only)
  const [copied, setCopied] = useState<string | null>(null);
  // #504: a revoked link is dead for good (a new link is a new URL) — confirm before revoking.
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const linkUrl = (id: string) => `${location.origin}/share/${id}`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {/* #460 same pattern as the permissions dialog — the first tabbable is a Select trigger
          with a focus-visible ring, so a mouse open painted a ring on it. See PermissionsDialog for
          why the container is focused explicitly. */}
      <DialogContent data-testid="share-dialog" onOpenAutoFocus={(e) => { e.preventDefault(); (e.target as HTMLElement | null)?.focus?.(); }} className="sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle>{isSpace ? t("shareDialog.spaceTitle") : t("shareDialog.title")}</DialogTitle>
        </DialogHeader>

        {isSpace && (
          <div data-testid="share-space-warning" className="rounded-md border border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] px-3 py-2 text-xs text-fg-dim">
            {t("shareDialog.spaceWarning")}
          </div>
        )}

        <div className="flex items-center gap-2">
          {/* #274 / ADR-135: SPACE links choose view/edit too now — an EDIT space link is the anonymous
              wiki (every published, non-private page editable via the one link). The server is the
              fortress (manage-gated issuance + the spaceEditLink entitlement → 402 on gated plans). */}
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
          <Input
            type="password"
            value={password}
            aria-label={t("shareDialog.password")}
            placeholder={t("shareDialog.password")}
            data-testid="share-password"
            className="h-8 w-40 text-sm"
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            variant="primary"
            size="sm"
            data-testid="create-link"
            disabled={!resource || create.isPending}
            onClick={() => resource && create.mutate({ resource, capability, expiresInSeconds: expiry, password: password.trim() || null }, {
              onSuccess: () => { notify.success(t("toast.linkCreated")); setPassword(""); },
              onError: () => notify.error(t("toast.actionFailed")),
            })}
          >
            {t("shareDialog.create")}
          </Button>
        </div>

        <div className="mt-3 flex max-h-[55vh] flex-col gap-2 overflow-y-auto" data-testid="link-list">
          {links.isLoading ? (
            <div className="text-sm text-fg-dim">{t("common.loading")}</div>
          ) : links.isError ? (
            // #888: said BEFORE the empty branch. "No links" here is an answer about who can reach
            // this page, and a request that failed established nothing of the sort.
            <LoadFailed testId="share-links-failed" onRetry={() => { void links.refetch(); }} />
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
                {/* #504: irreversible in effect (the URL dies for everyone; a new link is a new URL) —
                    confirm first. Red at rest via the shared danger variant. */}
                <IconButton
                  aria-label={t("shareDialog.revoke")}
                  title={t("shareDialog.revoke")}
                  data-testid="revoke-link"
                  variant="danger"
                  onClick={() => setRevokingId(l.id)}
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
        {/* #504: the revoke confirm — stacked above this dialog. */}
        <ConfirmDialog
          open={revokingId !== null}
          stacked
          message={t("shareDialog.revokeConfirm")}
          confirmTestId="revoke-link-confirm"
          confirmLabel={t("shareDialog.revoke")}
          onClose={() => setRevokingId(null)}
          onConfirm={() => {
            if (revokingId && resource) revoke.mutate({ id: revokingId, resource }, {
              onSuccess: () => notify.success(t("toast.linkRevoked")),
              onError: () => notify.error(t("toast.actionFailed")),
            });
            setRevokingId(null);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
