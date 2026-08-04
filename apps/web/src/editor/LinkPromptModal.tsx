import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { linkHref, type LinkPromptResult } from "./live-preview/decorations";

// #611 / ADR-211 §2: the LINK DIALOG — the WYSIWYG door for insert/edit/unlink, in the EmbedUrlModal
// idiom (#210: in-app modal, never window.prompt; Radix Dialog, Esc via onOpenChange, focus-trapped).
// Confirm is REFUSED unless `linkHref` (the editor's one URL judge) resolves the value: an empty URL
// writes `[text]()`, which WYSIWYG renders RAW via the bare-shortcut rule — the very markup the mode
// promises to hide. "Remove link" appears only in edit mode (there is nothing to remove on insert).
export function LinkPromptModal({ open, init, onDone }: {
  open: boolean;
  init: { text: string; url: string; existing: boolean };
  onDone: (r: LinkPromptResult) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(init.text);
  const [url, setUrl] = useState(init.url);
  useEffect(() => { if (open) { setText(init.text); setUrl(init.url); } }, [open, init]);
  const trimmedUrl = url.trim();
  const valid = trimmedUrl !== "" && linkHref(`[x](${trimmedUrl})`) !== null;
  const confirm = () => { if (valid) onDone({ action: "confirm", text: text.trim() || trimmedUrl, url: trimmedUrl }); };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onDone({ action: "cancel" }); }}>
      <DialogContent position="top">
        <DialogHeader><DialogTitle>{init.existing ? t("linkDialog.editTitle") : t("linkDialog.insertTitle")}</DialogTitle></DialogHeader>
        <label className="flex flex-col gap-1 text-xs text-fg-dim">
          {t("linkDialog.textLabel")}
          <Input value={text} onChange={(e) => setText(e.target.value)} aria-label={t("linkDialog.textLabel")}
            data-testid="link-dialog-text" autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }} />
        </label>
        <label className="mt-2 flex flex-col gap-1 text-xs text-fg-dim">
          {t("linkDialog.urlLabel")}
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…"
            aria-label={t("linkDialog.urlLabel")} data-testid="link-dialog-url"
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); confirm(); } }} />
        </label>
        {trimmedUrl !== "" && !valid && (
          <p className="mt-2 text-xs text-fg-dim" data-testid="link-dialog-invalid">{t("linkDialog.invalidUrl")}</p>
        )}
        <DialogFooter>
          {init.existing && (
            <Button variant="dangerGhost" size="sm" className="mr-auto" onClick={() => onDone({ action: "unlink" })}
              data-testid="link-dialog-unlink">{t("linkDialog.removeLink")}</Button>
          )}
          <Button variant="default" size="sm" onClick={() => onDone({ action: "cancel" })} data-testid="link-dialog-cancel">{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" onClick={confirm} disabled={!valid} data-testid="link-dialog-save">{t("common.save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
