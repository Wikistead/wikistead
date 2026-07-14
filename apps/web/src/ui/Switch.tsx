import type { ReactNode } from "react";
import { Switch as SwitchRoot } from "../components/ui/switch";
import { cn } from "@/lib/utils";

// #389 / ADR-146: the DS on/off control (role=switch + aria-checked; the knob position is the non-colour
// cue). Replaces both the bare <input type=checkbox> toggles and the hand-rolled role=switch buttons.
// The bare control for custom layouts; SwitchRow for the common bordered label+hint row.
export function Switch({
  checked, onChange, disabled, testId, ariaLabel, className, ...rest
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  testId?: string;
  ariaLabel?: string;
  className?: string;
} & Record<`data-${string}`, unknown>) {
  return (
    <SwitchRoot
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={ariaLabel}
      data-testid={testId}
      className={className}
      {...rest}
    />
  );
}

export function SwitchRow({
  checked, onChange, label, description, disabled, testId, rowTestId, className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  testId?: string;
  rowTestId?: string;
  className?: string;
}) {
  return (
    <label
      data-testid={rowTestId}
      className={cn("flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5 transition-colors duration-[120ms] hover:bg-panel", className)}
    >
      <Switch checked={checked} onChange={onChange} disabled={disabled} testId={testId} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-foreground">{label}</span>
        {description != null && <span className="block text-xs text-fg-dim">{description}</span>}
      </span>
    </label>
  );
}
