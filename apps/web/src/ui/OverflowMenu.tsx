import { Check, MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { IconButton } from "./Button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";

// A ••• overflow menu (Radix DropdownMenu) for secondary page actions — the IA pattern
// of keeping the top bar minimal and folding occasional actions away (Phase 3b-3).
export interface OverflowItem {
  value: string;
  label: string;
  icon?: ReactNode;
  testId?: string;
  danger?: boolean;
  disabled?: boolean; // grayed out + not selectable (e.g. a temporarily-sealed action)
  hint?: string; // tooltip (#1044: data-tip, not the native title) — e.g. why a disabled item is unavailable
  checked?: boolean; // #212: a TOGGLE item (e.g. comments panel open/closed) — trailing ✓ when on
}

export function OverflowMenu({
  items,
  onSelect,
  label = "More actions",
  testId = "page-overflow",
  triggerClassName,
  onOpenChange,
}: {
  items: OverflowItem[];
  onSelect: (value: string) => void;
  label?: string;
  testId?: string;
  triggerClassName?: string;
  onOpenChange?: (open: boolean) => void; // #489: lets the host defer per-item data until the menu opens
}) {
  return (
    <DropdownMenu modal={false} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label={label} data-tip={label} data-testid={`${testId}-trigger`} className={triggerClassName}>
          <MoreHorizontal size={16} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid={testId}>
        {items.map((it) => (
          <DropdownMenuItem
            key={it.value}
            onSelect={() => { if (!it.disabled) onSelect(it.value); }}
            disabled={it.disabled}
            data-tip={it.hint}
            data-testid={it.testId}
            data-danger={it.danger ? "" : undefined}
            data-checked={it.checked ? "" : undefined}
            aria-checked={it.checked === undefined ? undefined : it.checked}
            role={it.checked === undefined ? undefined : "menuitemcheckbox"}
            variant={it.danger ? "destructive" : "default"}
          >
            {it.icon}
            {it.label}
            {/* #212: a toggle item shows its ON state with a trailing check (state via icon, not colour). */}
            {it.checked && <Check size={14} className="ml-auto text-[var(--accent)]" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
