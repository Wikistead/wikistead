import { MoreHorizontal } from "lucide-react";
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
}

export function OverflowMenu({
  items,
  onSelect,
  label = "More actions",
  testId = "page-overflow",
  triggerClassName,
}: {
  items: OverflowItem[];
  onSelect: (value: string) => void;
  label?: string;
  testId?: string;
  triggerClassName?: string;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <IconButton aria-label={label} title={label} data-testid={`${testId}-trigger`} className={triggerClassName}>
          <MoreHorizontal size={16} />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid={testId}>
        {items.map((it) => (
          <DropdownMenuItem
            key={it.value}
            onSelect={() => onSelect(it.value)}
            data-testid={it.testId}
            data-danger={it.danger ? "" : undefined}
            variant={it.danger ? "destructive" : "default"}
          >
            {it.icon}
            {it.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
