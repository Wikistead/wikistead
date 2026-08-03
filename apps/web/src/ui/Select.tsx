import type React from "react";
import { useRef, useState } from "react";
import { Select as SelectRoot, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { useControlScale } from "./FormRow";

export interface SelectOption {
  value: string;
  label: string;
  /**
   * #586 (review rejection, 2026-08-03): what choosing this option would confer, revealed ON HOVER rather
   * than printed under every label. Nine two-line options made the reader read the whole vocabulary
   * before choosing one; the name is what you pick by, and the meaning is what you ask for.
   *
   * A wrapper rather than a list of words, because the wrapper is where the meaning comes from — the
   * caller hands the label to `RoleTip`, which looks the capabilities up from the one measured table.
   * This component stays about selects.
   */
  wrap?: (label: React.ReactNode) => React.ReactNode;
}

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
  // #582: the open list is portalled to the body, and Radix keeps it inside the VIEWPORT — which says
  // nothing about the dialog the control lives in. A long option grew the list rightwards and carried it
  // out past the dialog's edge (measured 28px over, and outside it in the DOM), where a reader looking at
  // the dialog cannot follow it. Handing Radix the dialog as the boundary makes it shift or flip within
  // that box instead. Outside a dialog there is no boundary and the viewport rule applies, unchanged.
  const trigger = useRef<HTMLButtonElement>(null);
  const [boundary, setBoundary] = useState<Element | null>(null);
  return (
    <SelectRoot
      value={value === "" ? EMPTY_SENTINEL : value}
      onValueChange={(v) => { if (v != null) onChange(v === EMPTY_SENTINEL ? "" : v); }}
      disabled={disabled}
      // read on open, not on mount: the trigger may be mounted before the dialog around it exists
      onOpenChange={(open) => { if (open) setBoundary(trigger.current?.closest("[role=dialog]") ?? null); }}
    >
      <SelectTrigger ref={trigger} size={scale === "sm" ? "sm" : "default"} aria-label={ariaLabel} data-testid={testId}>
        {/* The trigger shows the LABEL, not the option's rendered children. Radix's default clones the
            selected item, which since #586 carries a hidden capability line — so the closed control held
            text nobody could see, reserved width for it, and handed it to anything reading the element.
            The label is what "the value" means here; the reveal belongs to the open list. */}
        <SelectValue>{options.find((o) => o.value === value)?.label ?? undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent collisionBoundary={boundary ?? undefined} collisionPadding={8}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value === "" ? EMPTY_SENTINEL : o.value} data-testid={testId ? `${testId}-${o.value}` : undefined}>
            {o.wrap ? o.wrap(o.label) : o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
