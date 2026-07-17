import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { RadioGroup as RadioGroupRoot, RadioGroupChoice } from "../components/ui/radio-group";
import { cn } from "@/lib/utils";

export interface RadioOption {
  value: string;
  label: ReactNode;
  /** card variant only: a one-line explanation under the label */
  description?: ReactNode;
  disabled?: boolean;
}

// #389 / ADR-146: the DS single-select. One component, three looks — chosen by the nature of the choice:
//   - segmented: 2–4 short, self-evident options in a row (theme, TOC depth, capability).
//   - list: longer/vertical options (keymap, display mode, font).
//   - card: options that need a description line (enrollment policy, visibility).
// Real radiogroup semantics come from Radix (role=radio + aria-checked + arrow-key roving focus) and the
// selected cue is never colour alone (fill + Check glyph / dot). Per-option test-ids follow the
// `${testId}-${value}` convention Select established, so tests keep clicking the same ids. The ROOT
// deliberately carries no data-testid (several call sites already have a same-named container id).
export function RadioGroup({
  value, onChange, options, variant = "list", ariaLabel, testId, disabled, className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: RadioOption[];
  variant?: "segmented" | "list" | "card";
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
  className?: string;
}) {
  const optId = (v: string) => (testId ? `${testId}-${v}` : undefined);
  if (variant === "segmented") {
    return (
      <RadioGroupRoot
        value={value}
        onValueChange={(v) => { if (v) onChange(v); }}
        disabled={disabled}
        aria-label={ariaLabel}
        orientation="horizontal"
        className={cn("inline-flex w-fit gap-0.5 rounded-md border border-border bg-panel p-0.5", className)}
      >
        {options.map((o) => (
          <RadioGroupChoice
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            data-testid={optId(o.value)}
            className="group inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-sm text-fg-dim outline-none transition-colors duration-[120ms] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground"
          >
            {/* glyph = the non-colour selected cue (hidden until this item is checked) */}
            <Check size={14} aria-hidden className="hidden group-data-[state=checked]:inline-block" />
            {o.label}
          </RadioGroupChoice>
        ))}
      </RadioGroupRoot>
    );
  }
  // list / card: the whole bordered row is the radio; a leading circle carries the dot.
  return (
    <RadioGroupRoot
      value={value}
      onValueChange={(v) => { if (v) onChange(v); }}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cn("flex flex-col gap-2", className)}
    >
      {options.map((o) => (
        <RadioGroupChoice
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          data-testid={optId(o.value)}
          className="group flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5 text-left outline-none transition-colors duration-[120ms] hover:bg-panel focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-panel"
        >
          <span
            aria-hidden
            className="mt-0.5 flex size-4 flex-none items-center justify-center rounded-full border border-input transition-colors duration-[120ms] group-data-[state=checked]:border-primary"
          >
            {/* #389 the checked steady-state carries NO transform (`transform-none`, not
                `scale-100`) — a persistent transform exempts the dot from device-pixel snapping, so
                at fractional zoom (110%/125%) it painted measurably off-center (+0.4 device px at
                1.25 in the probe). `none` interpolates from scale-0 like identity, so the pop
                animation is unchanged; only the resting raster snaps. */}
            <span className="size-2 scale-0 rounded-full bg-primary transition-transform duration-[120ms] group-data-[state=checked]:transform-none" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-foreground">{o.label}</span>
            {variant === "card" && o.description != null && (
              <span className="block text-xs text-fg-dim">{o.description}</span>
            )}
          </span>
        </RadioGroupChoice>
      ))}
    </RadioGroupRoot>
  );
}
