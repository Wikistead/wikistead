import { Select as SelectRoot, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";

export interface SelectOption { value: string; label: string }

// DS select wrapper over shadcn/Radix Select. Drop-in for the common single-value
// pattern; keeps the stable trigger testid plus per-option testids
// (`${testId}-${value}`) so tests click the trigger then the option.
export function Select({
  value, onChange, options, ariaLabel, disabled, testId, size = "md",
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  disabled?: boolean;
  testId?: string;
  size?: "sm" | "md";
}) {
  return (
    <SelectRoot value={value} onValueChange={(v) => { if (v != null) onChange(v); }} disabled={disabled}>
      <SelectTrigger size={size === "sm" ? "sm" : "default"} aria-label={ariaLabel} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} data-testid={testId ? `${testId}-${o.value}` : undefined}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
