import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "../components/ui/dialog";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { useTagSuggestions } from "../data/queries";
import { useDebouncedValue } from "../search/useDebouncedValue";

// #413 / ADR-145 §5: the tag picker for `:::tagged` insertion (mirrors EmbedUrlModal). Suggestions come
// from the member-only, view-filtered GET /tags/suggest — the server offers a tag only when the caller
// can view ≥1 page carrying it, so this modal can never reveal a tag that lives only on invisible pages.
// Free text is always allowed (a NEW tag is a valid target — the list renders empty until pages carry it).
export function TagPickerModal({ open, onSubmit }: { open: boolean; onSubmit: (tag: string | null) => void }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  useEffect(() => { if (open) setValue(""); }, [open]);
  const debounced = useDebouncedValue(value, 200);
  const suggestions = useTagSuggestions(debounced, open);
  const trimmed = value.trim();
  const submit = (tag: string | null) => onSubmit(tag);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) submit(null); }}>
      <DialogContent position="top">
        <DialogHeader><DialogTitle>{t("tagPicker.title")}</DialogTitle></DialogHeader>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("tagPicker.placeholder")}
          aria-label={t("tagPicker.title")}
          data-testid="tag-picker-input"
          autoFocus
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (trimmed) submit(trimmed); } }}
        />
        {(suggestions.data ?? []).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="tag-picker-suggestions">
            {(suggestions.data ?? []).map((s) => (
              <button
                key={s.tag}
                type="button"
                data-testid={`tag-suggestion-${s.tag}`}
                className="cursor-pointer rounded-full bg-panel-2 px-2.5 py-0.5 text-xs text-foreground hover:bg-panel-3"
                onClick={() => submit(s.display)}
              >
                {s.display}
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="default" size="sm" onClick={() => submit(null)} data-testid="tag-picker-cancel">{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" disabled={!trimmed} onClick={() => submit(trimmed)} data-testid="tag-picker-save">{t("tagPicker.insert")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
