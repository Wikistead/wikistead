import type { ReactNode } from "react";
import { Checkbox as CheckboxRoot } from "../components/ui/checkbox";
import { cn } from "@/lib/utils";

// #389 / ADR-146: the DS multi-select row — a real checkbox (role=checkbox + aria-checked + Check glyph,
// never colour-only) with its label as one clickable unit. Used for lists of independent opt-ins
// (editor chrome modes); a single on/off STATE wants Switch instead.
export function CheckboxRow({
  checked, onChange, label, description, disabled, testId, className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5 transition-colors duration-[120ms] hover:bg-panel has-data-[state=checked]:border-accent", className)}>
      <CheckboxRoot
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(v) => onChange(v === true)}
        data-testid={testId}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        {description != null && <span className="block text-xs text-fg-dim">{description}</span>}
      </span>
    </label>
  );
}
