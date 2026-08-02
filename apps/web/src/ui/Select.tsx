import { Select as SelectRoot, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { useControlScale } from "./FormRow";

export interface SelectOption { value: string; label: string }

// DS select wrapper over shadcn/Radix Select. Drop-in for the common single-value
// pattern; keeps the stable trigger testid plus per-option testids
// (`${testId}-${value}`) so tests click the trigger then the option.
//
// #536 Radix treats `value=""` as "no value" — the item renders (and checks) in the OPEN list,
// but the CLOSED trigger shows nothing, so an empty-valued option's label ("member", the built-in fallback)
// vanished exactly where it matters. Callers keep the natural `""` vocabulary; the wrapper maps it to a
// sentinel both ways so Radix always has a real value to resolve a label for.
const EMPTY_SENTINEL = "__wks-select-empty__";

export function Select({
  value, onChange, options, ariaLabel, disabled, testId, size,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  disabled?: boolean;
  testId?: string;
  size?: "sm" | "md";
}) {
  // #535: no `size` inside a FormRow means the row's scale; outside one it is the `md` it always was.
  const scale = useControlScale(size, "md");
  return (
    <SelectRoot value={value === "" ? EMPTY_SENTINEL : value} onValueChange={(v) => { if (v != null) onChange(v === EMPTY_SENTINEL ? "" : v); }} disabled={disabled}>
      <SelectTrigger size={scale === "sm" ? "sm" : "default"} aria-label={ariaLabel} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value === "" ? EMPTY_SENTINEL : o.value} data-testid={testId ? `${testId}-${o.value}` : undefined}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
