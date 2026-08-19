import { createContext, useContext, type HTMLAttributes } from "react";
import { cn } from "../lib/utils";

// #535: a form row puts every control it holds on ONE scale.
//
// The bug this exists to end came back three times. Each control declares its own height correctly —
// Button `md: h-9 / sm: h-8`, Select the same, Input `inputSize` — and each row was assembled by hand, so
// a row read `size="sm"` on the Select and the Button and nothing on the Input, which then rendered a
// 36px field beside two 32px controls. Seven rows across six files were ragged that way, and #536 added
// another one three minutes after the previous round was reviewed. Fixing rows one at a time was the
// wrong shape of answer: the next row anyone writes starts ragged again.
//
// So the scale stops being a per-control decision. A row declares it once; the controls inside read it.
// An explicit `size` on a control still wins, and OUTSIDE a row nothing changes at all — the context is
// null there, so every control keeps the default it had before this file existed.
export type ControlScale = "sm" | "md";

const FormScaleContext = createContext<ControlScale | null>(null);

/** The scale a control should render at: its own prop, else its row's, else the control's own default. */
export function useControlScale(explicit: ControlScale | null | undefined, fallback: ControlScale): ControlScale {
  const row = useContext(FormScaleContext);
  return explicit ?? row ?? fallback;
}

/**
 * One line of a form. Compact (`sm`, 32px) by default — that is what the settings screens already use.
 * Children are laid out in a wrapping flex row, and they line up along their BOTTOMS.
 *
 * #740 (ruling): bottoms, not centres. Once a field carries a visible label the label sits above
 * the box, so that child is a line taller than the button beside it — and centring made the box hang
 * 11px below every plain control on the row. Measured at that exact figure on three screens (the API
 * key row, the webhook row, the invite row), which is what "not one broken screen" looks like: it was
 * the row's rule, applied faithfully to a child whose shape had changed.
 *
 * Bottom alignment is what the eye reads as "these belong to one line" when one control wears a name
 * and its neighbour does not, and it costs nothing where nobody wears one — a row of equal-height
 * controls lays out identically either way, which is every other row in the product today. The
 * alternative on the table was padding the unlabelled side up to match, which is the same fix written
 * once per row and forgotten on the next one.
 */
export function FormRow({
  scale = "sm",
  className,
  children,
  ...rest
}: { scale?: ControlScale } & HTMLAttributes<HTMLDivElement>) {
  return (
    <FormScaleContext.Provider value={scale}>
      <div data-form-row="" className={cn("flex flex-wrap items-end gap-2", className)} {...rest}>
        {children}
      </div>
    </FormScaleContext.Provider>
  );
}
