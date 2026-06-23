import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useSearch, useSpaces } from "../data/queries";
import { useDebouncedValue } from "./useDebouncedValue";
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty } from "../components/ui/command";

// Tenant page search. The two-stage guard (Meili + FGA) lives entirely in the API;
// this component only renders the authorized hits it returns — `shouldFilter={false}`
// means cmdk does NO client-side filtering, so the list is EXACTLY the server's
// authorized result set (a UI change can neither leak nor re-filter authz). The body
// snippet is plain text (API-stripped) rendered AS TEXT (never dangerouslySetInnerHTML),
// and only ever appears for a page the user may view. Cmd/Ctrl-K focuses the input.
export function SearchBox() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [input, setInput] = useState("");
  const debounced = useDebouncedValue(input, 250);
  const { data: hits, isFetching } = useSearch(debounced);
  const spaces = useSpaces();

  const spaceName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of spaces.data ?? []) m.set(s.id, s.name || "Untitled space");
    return m;
  }, [spaces.data]);

  const items = useMemo(
    () => (hits ?? []).map((h) => ({
      value: h.id,
      label: h.title || "Untitled",
      space: spaceName.get(h.spaceId) ?? "",
      snippet: h.snippet ?? "",
    })),
    [hits, spaceName],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        document.querySelector<HTMLInputElement>("[data-testid=search-input]")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const open = input.trim().length > 0;

  return (
    <Command shouldFilter={false} className="relative w-full max-w-xs overflow-visible bg-transparent">
      <CommandInput
        value={input}
        onValueChange={setInput}
        data-testid="search-input"
        placeholder={t("search.placeholderKbd")}
      />
      {open && (
        <CommandList data-testid="search-results" className="absolute top-full right-0 left-0 z-50 mt-1 rounded-md border bg-popover text-popover-foreground shadow-md">
          {isFetching && items.length === 0 ? (
            <div className="p-2 text-sm text-fg-dim">{t("search.searching")}</div>
          ) : items.length === 0 ? (
            <CommandEmpty>{t("search.noResults")}</CommandEmpty>
          ) : (
            items.map((item) => (
              <CommandItem
                key={item.value}
                value={item.value}
                data-testid="search-item"
                onSelect={(v) => { navigate(`/p/${v}`); setInput(""); }}
                className="flex flex-col items-start gap-0.5"
              >
                <span className="text-sm">{item.label}</span>
                {item.space && <span className="text-xs text-fg-dim">{item.space}</span>}
                {item.snippet && <span className="text-xs text-fg-dim" data-testid="search-snippet">{item.snippet}</span>}
              </CommandItem>
            ))
          )}
        </CommandList>
      )}
    </Command>
  );
}
