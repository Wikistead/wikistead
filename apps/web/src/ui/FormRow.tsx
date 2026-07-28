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
 * Children are laid out in a wrapping flex row, centred, so the heights that now agree also line up.
 */
export function FormRow({
  scale = "sm",
  className,
  children,
  ...rest
}: { scale?: ControlScale } & HTMLAttributes<HTMLDivElement>) {
  return (
    <FormScaleContext.Provider value={scale}>
      <div className={cn("flex flex-wrap items-center gap-2", className)} {...rest}>
        {children}
      </div>
    </FormScaleContext.Provider>
  );
}
