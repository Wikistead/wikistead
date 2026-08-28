import { useState } from "react";
import { ListRow, ListBox } from "../ui/list-rows";
import { useTranslation } from "react-i18next";
import { ListState } from "../ui/ListState";
import { Copy, Trash2 } from "lucide-react";
import { useWebhooks, useCreateWebhook, useDeleteWebhook, type WebhookCreated } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { FormRow } from "../ui/FormRow";
import { ConfirmDialog } from "../ui/dialogs"; // #504: deleting an endpoint drops its config + secret
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading

const label = "mb-1.5 mt-[18px] block text-sm text-fg-dim";

// #228 / ADR-108: outbound webhooks admin console. Tenant-admin only (server re-checks). A webhook posts a
// thin, HMAC-signed event to an https URL; the signing secret is shown ONCE on creation. Deliveries use the
// SSRF-safe pinned client and auto-disable after repeated failures (failure_count / active surfaced here).
export function AdminWebhooksTab() {
  const { t } = useTranslation();
  const hooks = useWebhooks();
  const create = useCreateWebhook();
  const del = useDeleteWebhook();
  const [url, setUrl] = useState("");
  // #504: the endpoint's secret dies with it (a re-add mints a new one) — confirm, by URL.
  const [deleting, setDeleting] = useState<{ id: string; url: string } | null>(null);
  const [created, setCreated] = useState<WebhookCreated | null>(null);

  const onCreate = () => {
    if (!url.trim()) return;
    create.mutate({ url: url.trim() }, {
      onSuccess: (w) => { setCreated(w); setUrl(""); notify.success(t("toast.saved")); },
      onError: () => notify.error(t("adminWebhooks.createFailed")),
    });
  };

  return (
    <SettingsPane width="list" testId="admin-webhooks" title={t("adminWebhooks.title")} description={t("adminWebhooks.body")}>

      <label className={label}>{t("adminWebhooks.createTitle")}</label>
      <FormRow>
        {/* #740 an example URL shows the shape of an answer and names nothing. */}
        <label className="flex flex-col gap-1 text-xs text-fg-dim">
          {t("adminWebhooks.url")}
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhook" data-testid="webhook-url" />
        </label>
        <Button variant="primary" disabled={!url.trim() || create.isPending} onClick={onCreate} data-testid="webhook-create">{t("adminWebhooks.create")}</Button>
      </FormRow>

      {created && (
        <div className="my-3.5 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] px-3 py-2.5" data-testid="webhook-secret">
          <p className="text-xs text-fg-dim">{t("adminWebhooks.secretOnce")}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs [overflow-wrap:anywhere]">{created.secret}</code>
            <IconButton aria-label={t("adminWebhooks.copy")} data-tip={t("adminWebhooks.copy")} onClick={() => { navigator.clipboard?.writeText(created.secret); notify.success(t("toast.copied")); }}>
              <Copy size={14} />
            </IconButton>
          </div>
        </div>
      )}

      <ListBox className="mt-5" data-testid="webhook-list">
        {/* ADR-266 §3.1: this was #888's own "did not even wait for the request" surface — "no
            endpoints" flashed while loading and stayed if the fetch failed. The chokepoint keeps
            the same loading-shows-nothing shape (`loading={null}`) without a hand-rolled guard. */}
        <ListState
          query={hooks}
          fallback={[]}
          isEmpty={(list) => list.length === 0}
          loading={null}
          empty={<p className="text-xs text-fg-dim">{t("adminWebhooks.empty")}</p>}
          testId="admin-webhooks-failed"
        >
          {(list) => list.map((h) => (
            <ListRow key={h.id} data-testid="webhook-item">
              {!h.active && <span className="flex-none rounded-full border border-[var(--danger)] px-2 py-px text-[11px] uppercase tracking-[0.03em] text-[var(--danger)]" data-testid="webhook-disabled">{t("adminWebhooks.disabled")}</span>}
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{h.url}</span>
              {/* #504: red at rest + confirm (the secret cannot be re-shown; a re-add is a new endpoint). */}
              <IconButton aria-label={t("adminWebhooks.delete")} data-testid="webhook-delete" variant="danger"
                onClick={() => setDeleting({ id: h.id, url: h.url })}>
                <Trash2 size={14} />
              </IconButton>
            </ListRow>
          ))}
        </ListState>
      </ListBox>
      {/* #504: the endpoint-delete confirm — names the URL. */}
      <ConfirmDialog
        open={deleting !== null}
        message={deleting ? t("adminWebhooks.deleteConfirm", { url: deleting.url }) : ""}
        confirmTestId="webhook-delete-confirm"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) del.mutate(deleting.id, { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("adminWebhooks.createFailed")) });
          setDeleting(null);
        }}
      />
    </SettingsPane>
  );
}
