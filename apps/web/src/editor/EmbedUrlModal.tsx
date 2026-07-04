import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { useEmbedProviders } from "../data/queries";
import { isAllowlistedEmbed } from "./macros/embed";

// #210 bounce: the in-app URL modal for `:::embed-external` (replacing window.prompt). Seeded with the
// current URL; on save the host writes it back via embedRetargetChange (unchanged). Using the tenant
// allowlist (useEmbedProviders / GET /embed/providers) it warns when the typed host isn't allowlisted —
// the embed would then degrade to a link (save is still allowed; the warning is informational). The
// render path (isAllowlistedEmbed + sandbox + same-origin refusal) is the real gate; this is UI only.
export function EmbedUrlModal({ open, current, onSubmit }: { open: boolean; current: string; onSubmit: (url: string | null) => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState(current);
  useEffect(() => { if (open) setUrl(current); }, [open, current]);
  const providers = useEmbedProviders();
  const allow = providers.data?.providers ?? [];
  const trimmed = url.trim();
  // A non-empty URL whose host isn't allowlisted (or is our own origin) will render as a link, not an
  // iframe — mirror the render guard (isAllowlistedEmbed) so the warning matches what will actually show.
  const willDegrade = trimmed !== "" && !isAllowlistedEmbed(trimmed, allow);
  const submit = (u: string | null) => onSubmit(u);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) submit(null); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t("embedUrl.title")}</DialogTitle></DialogHeader>
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/embed/…"
          aria-label={t("embedUrl.title")}
          data-testid="embed-url-input"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(trimmed || null); } }}
        />
        {willDegrade && <p className="mt-2 text-xs text-fg-dim" data-testid="embed-url-warning">{t("embedUrl.degradeWarning")}</p>}
        <DialogFooter>
          <Button variant="default" size="sm" onClick={() => submit(null)} data-testid="embed-url-cancel">{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" onClick={() => submit(trimmed || null)} data-testid="embed-url-save">{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
