import { useRef, type ReactNode } from "react";
import { RadioGroup as RadioGroupRoot, RadioGroupChoice } from "../components/ui/radio-group";
import { cn } from "@/lib/utils";

export interface RadioOption {
  value: string;
  label: ReactNode;
  /** #493: an optional leading glyph shown before the label in every variant. */
  icon?: ReactNode;
  /** card variant only: a one-line explanation under the label */
  description?: ReactNode;
  /** #587: hover text for an option whose label is visually hidden (an icon-only segment). Uses the
   *  in-house tooltip (#530), never native title. */
  tip?: string;
  disabled?: boolean;
}

// #389 / ADR-146: the DS single-select. One component, three looks — chosen by the nature of the choice:
//   - segmented: 2–4 short, self-evident options in a row (theme, TOC depth, capability).
//   - list: longer/vertical options (keymap, display mode, font).
//   - card: options that need a description line (enrollment policy, visibility).
// Real radiogroup semantics come from Radix (role=radio + aria-checked + arrow-key roving focus).
//
// #587 (user ruling): the selected cue in the SEGMENTED variant is the accent fill, and the Check glyph
// is gone. ADR-146 said the cue must never be colour alone; the fill is a non-text cue that satisfies
// the intent, and the clause is updated rather than quietly broken (see the ADR-146 addendum). list /
// card keep their dot: those rows are not filled, so there the colour WOULD be alone.
//
// #587 also fixes the arrow keys. Measured on /settings/account/theme: click `light`, press
// ArrowRight, and focus moves to `dark` while the selection stays on `light` — the second press then
// lands on `system`, so `dark` is unreachable by keyboard. Radix checks an item on focus only when it
// believes an arrow key is down, and on the first press its own document-level keydown listener has
// not run yet when the focus lands. Tracking it in the CAPTURE phase here runs before focus moves, so
// the first press selects like the rest of them.
// Per-option test-ids follow the
// `${testId}-${value}` convention Select established, so tests keep clicking the same ids. The ROOT
// deliberately carries no data-testid (several call sites already have a same-named container id).
export function RadioGroup({
  value, onChange, options, variant = "list", ariaLabel, testId, disabled, className, optionClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  options: RadioOption[];
  variant?: "segmented" | "list" | "card";
  ariaLabel?: string;
  testId?: string;
  disabled?: boolean;
  className?: string;
  /** #587 bounce: per-surface geometry for the SEGMENT itself. `className` only reached the container,
   *  so adopting the DS silently replaced the display-mode pill's 28x28 circles with the DS rectangle.
   *  A surface that already had a settled shape overrides it here and keeps the behaviour. */
  optionClassName?: string;
}) {
  const optId = (v: string) => (testId ? `${testId}-${v}` : undefined);
  // #587 bounce ②: Radix leaves EVERY item at tabIndex -1 until something is focused (its
  // RovingFocusGroup starts with no current tab stop and the group div carries the tab stop instead).
  // For the floating pill that read as "cannot reach it with Tab at all". The checked item is the tab
  // stop from the first paint, and Radix's roving still works because it spreads our props AFTER its
  // own tabIndex, and the item it moves the stop to is the one it also checks.
  const tabIndexOf = (v: string) => (v === value ? 0 : -1);
  // true while an arrow key is being handled — set in the capture phase, i.e. before Radix moves focus
  const arrowKey = useRef(false);
  const rootKeys = {
    // any non-arrow key (Tab, Enter, a letter) clears it; a pointer press clears it. NOT keyup:
    // Radix moves the focus from an effect AFTER its re-render, which for a fast synthetic press
    // lands after the key is already up — clearing there is what made the first press do nothing
    // (measured: `kd:ArrowRight=true` then `focus:dark arrow=false`).
    onKeyDownCapture: (e: { key: string }) => { arrowKey.current = e.key.startsWith("Arrow"); },
    onPointerDownCapture: () => { arrowKey.current = false; },
  };
  const selectOnArrowFocus = (o: RadioOption) => () => {
    if (!arrowKey.current) return;
    arrowKey.current = false; // consumed by the focus it caused
    if (!disabled && !o.disabled && o.value !== value) onChange(o.value);
  };
  if (variant === "segmented") {
    return (
      <RadioGroupRoot
        value={value}
        onValueChange={(v) => { if (v) onChange(v); }}
        disabled={disabled}
        aria-label={ariaLabel}
        orientation="horizontal"
        {...rootKeys}
        className={cn("inline-flex w-fit gap-0.5 rounded-md border border-border bg-panel p-0.5", className)}
      >
        {options.map((o) => (
          <RadioGroupChoice
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            data-testid={optId(o.value)}
            data-tip={o.tip}
            onFocus={selectOnArrowFocus(o)}
            tabIndex={tabIndexOf(o.value)}
            className={cn(
              "group inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-sm text-fg-dim outline-none transition-colors duration-[120ms] hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary data-[state=checked]:font-medium data-[state=checked]:text-primary-foreground",
              optionClassName,
            )}
          >
            {o.icon != null && <span aria-hidden className="flex-none [&_svg]:size-3.5">{o.icon}</span>}
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
      {...rootKeys}
      className={cn("flex flex-col gap-2", className)}
    >
      {options.map((o) => (
        <RadioGroupChoice
          key={o.value}
          value={o.value}
          disabled={o.disabled}
          data-testid={optId(o.value)}
          onFocus={selectOnArrowFocus(o)}
          tabIndex={tabIndexOf(o.value)}
          className="group flex cursor-pointer items-start gap-2.5 rounded-md border border-border p-2.5 text-left outline-none transition-colors duration-[120ms] hover:bg-panel focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-panel"
        >
          {/* #389the ring PAINTS its own dot (a radial-gradient background, faded in via the
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
            <span className="flex items-center gap-1.5 text-sm text-foreground">{o.icon != null && <span aria-hidden className="flex-none text-fg-dim [&_svg]:size-4">{o.icon}</span>}{o.label}</span>
            {variant === "card" && o.description != null && (
              <span className="block text-xs text-fg-dim">{o.description}</span>
            )}
          </span>
        </RadioGroupChoice>
      ))}
    </RadioGroupRoot>
  );
}
