import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Trash2 } from "lucide-react";
import { useWebhooks, useCreateWebhook, useDeleteWebhook, type WebhookCreated } from "../data/queries";
import { Button, IconButton } from "../ui/Button";
import { Input } from "../ui/Input";
import { notify } from "../ui/toast";

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
  const [created, setCreated] = useState<WebhookCreated | null>(null);

  const onCreate = () => {
    if (!url.trim()) return;
    create.mutate({ url: url.trim() }, {
      onSuccess: (w) => { setCreated(w); setUrl(""); notify.success(t("toast.saved")); },
      onError: () => notify.error(t("adminWebhooks.createFailed")),
    });
  };

  return (
    <div className="max-w-[640px] p-6" data-testid="admin-webhooks">
      <h2 className="mt-0">{t("adminWebhooks.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("adminWebhooks.body")}</p>

      <label className={label}>{t("adminWebhooks.createTitle")}</label>
      <div className="flex items-center gap-2">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhook" aria-label={t("adminWebhooks.url")} data-testid="webhook-url" />
        <Button variant="primary" size="sm" disabled={!url.trim() || create.isPending} onClick={onCreate} data-testid="webhook-create">{t("adminWebhooks.create")}</Button>
      </div>

      {created && (
        <div className="my-3.5 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] px-3 py-2.5" data-testid="webhook-secret">
          <p className="text-xs text-fg-dim">{t("adminWebhooks.secretOnce")}</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs [overflow-wrap:anywhere]">{created.secret}</code>
            <IconButton aria-label={t("adminWebhooks.copy")} title={t("adminWebhooks.copy")} onClick={() => { navigator.clipboard?.writeText(created.secret); notify.success(t("toast.copied")); }}>
              <Copy size={14} />
            </IconButton>
          </div>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-1" data-testid="webhook-list">
        {(hooks.data ?? []).map((h) => (
          <div key={h.id} className="flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2" data-testid="webhook-item">
            {!h.active && <span className="flex-none rounded-full border border-[var(--danger)] px-2 py-px text-[11px] uppercase tracking-[0.03em] text-[var(--danger)]" data-testid="webhook-disabled">{t("adminWebhooks.disabled")}</span>}
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{h.url}</span>
            <IconButton aria-label={t("adminWebhooks.delete")} data-testid="webhook-delete" className="hover:text-destructive"
              onClick={() => del.mutate(h.id, { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("adminWebhooks.createFailed")) })}>
              <Trash2 size={14} />
            </IconButton>
          </div>
        ))}
        {(hooks.data?.length ?? 0) === 0 && <p className="text-xs text-fg-dim">{t("adminWebhooks.empty")}</p>}
      </div>
    </div>
  );
}
