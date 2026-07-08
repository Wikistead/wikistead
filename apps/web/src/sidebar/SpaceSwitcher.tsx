import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsUpDown, Pencil, Plus } from "lucide-react";
import { Command, CommandInput, CommandList, CommandItem, CommandEmpty, CommandGroup, CommandSeparator } from "../components/ui/command";
import { SpaceIcon } from "../ui/SpaceIcon";
import type { Space } from "../data/queries";
import { visibleSpaces, recordRecentSpace } from "./space-recent";

// #263: the space switcher. #226 auto-creates a personal space per member, so a flat list of every
// viewable space grows unbounded (a tenant admin sees everyone's). The default view is now BOUNDED — the
// current space + recently-used spaces (space-recent.ts) — with an incremental SEARCH over ALL viewable
// spaces (client-side, over the server's FGA-filtered useSpaces() set only, so no new permission surface).
// cmdk gives ↑↓/Enter.

export function SpaceSwitcher({
  spaces, currentId, currentSpace, canManage, onSelect, onRename, onNewSpace,
}: {
  spaces: Space[];
  currentId: string | undefined;
  currentSpace: Space | undefined;
  canManage: boolean;
  onSelect: (id: string) => void;
  onRename: () => void;
  onNewSpace: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown, true); document.removeEventListener("keydown", onKey, true); };
  }, [open]);

  const list = useMemo(() => visibleSpaces(spaces, currentId, query), [spaces, currentId, query]);

  const select = (id: string) => { onSelect(id); recordRecentSpace(id); setOpen(false); setQuery(""); };

  return (
    <div className="relative min-w-0 flex-1" ref={boxRef}>
      <button
        type="button"
        data-testid="space-switcher"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 font-semibold text-foreground transition-colors duration-[120ms] hover:bg-panel-2"
      >
        {currentSpace && <SpaceIcon id={currentSpace.id} name={currentSpace.name} image={currentSpace.iconImageUrl} size={20} data-testid="space-icon" />}
        <span className="overflow-hidden text-ellipsis whitespace-nowrap">{currentSpace?.name || t("sidebar.noSpace")}</span>
        <ChevronsUpDown size={14} className="flex-none" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-64 max-w-[80vw] rounded-md border border-border bg-popover text-popover-foreground shadow-md" data-testid="space-menu">
          <Command shouldFilter={false} className="bg-transparent">
            <CommandInput value={query} onValueChange={setQuery} placeholder={t("sidebar.searchSpaces")} data-testid="space-search" autoFocus />
            <CommandList className="max-h-[40vh]">
              <CommandEmpty>{t("sidebar.noSpacesMatch")}</CommandEmpty>
              <CommandGroup>
                {list.map((s) => (
                  <CommandItem key={s.id} value={`space:${s.id}`} onSelect={() => select(s.id)} data-testid="space-option">
                    <SpaceIcon id={s.id} name={s.name} image={s.iconImageUrl} size={18} />
                    <span className="truncate">{s.name || t("sidebar.untitledSpace")}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                {currentSpace && canManage && (
                  <CommandItem value="__rename" onSelect={() => { onRename(); setOpen(false); }} data-testid="space-rename">
                    <Pencil size={13} /> {t("sidebar.renameSpace")}
                  </CommandItem>
                )}
                <CommandItem value="__new" onSelect={() => { onNewSpace(); setOpen(false); }} data-testid="space-new">
                  <Plus size={13} /> {t("sidebar.newSpace")}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      )}
    </div>
  );
}
