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
          {/* #389 the ring PAINTS its own dot (a radial-gradient background, faded in via the
              registered --wks-dot property in ds-controls.css). A child dot is a second paint box
              that rounds to device pixels independently of the ring, which is what made the dot sit
              up to 1 device px low at 125%/150% zoom while the geometry matched perfectly. One box
              cannot drift from itself. Do not put the dot back as an element, and never animate it
              with a transform (`scale-*` and `transform-none` are separate properties in
              Tailwind v4, and a resting transform also defeats pixel snapping). */}
          <span
            aria-hidden
            className="wks-radio-ring mt-0.5 size-4 flex-none rounded-full"
          />
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
