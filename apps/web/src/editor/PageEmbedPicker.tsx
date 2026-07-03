import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from "../components/ui/command";
import { useSearch, useSpaces } from "../data/queries";
import { useDebouncedValue } from "../search/useDebouncedValue";

// #205 part 2 / ADR-071: the title-search page picker for `:::embed-page`. Candidates come from
// GET /search — the SAME two-stage guard (Meili + FGA `view`) as global search — and cmdk runs with
// shouldFilter={false}, so the list is EXACTLY the server's authorized set: a page the user can't
// view is never offered (no existence leak; no client re-filter can add one). An id can also be typed
// directly (the raw-id fallback), so embedding stays possible even when a query returns nothing.
export function PageEmbedPicker({ open, onPick }: { open: boolean; onPick: (pageId: string | null) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const debounced = useDebouncedValue(input, 250);
  const { data: hits } = useSearch(debounced);
  const spaces = useSpaces();
  const spaceName = (id: string) => (spaces.data ?? []).find((s) => s.id === id)?.name ?? "";

  const close = (id: string | null) => { setInput(""); onPick(id); };
  // A raw id (or url tail) typed directly — the escape hatch when search can't reach a page (e.g. a
  // brand-new page not yet indexed). Trimmed; only offered when it looks like a bare token.
  const raw = input.trim();
  const looksLikeId = raw.length > 0 && !/\s/.test(raw);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(null); }}>
      <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="sr-only"><DialogTitle>{t("embedPicker.title")}</DialogTitle></DialogHeader>
        <Command shouldFilter={false} className="bg-transparent">
          <CommandInput
            value={input}
            onValueChange={setInput}
            data-testid="embed-picker-input"
            placeholder={t("embedPicker.placeholder")}
            autoFocus
          />
          <CommandList>
            <CommandEmpty>{t("embedPicker.empty")}</CommandEmpty>
            {(hits ?? []).map((h) => (
              <CommandItem key={h.id} value={h.id} onSelect={() => close(h.id)} data-testid="embed-picker-item">
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{h.title || t("common.untitled")}</span>
                  {spaceName(h.spaceId) && <span className="truncate text-xs text-fg-dim">{spaceName(h.spaceId)}</span>}
                </div>
              </CommandItem>
            ))}
            {looksLikeId && (
              <CommandItem value={`__raw__${raw}`} onSelect={() => close(raw)} data-testid="embed-picker-raw">
                {t("embedPicker.useId", { id: raw })}
              </CommandItem>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
