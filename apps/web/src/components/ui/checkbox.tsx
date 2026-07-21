import * as React from "react"
import { CheckIcon } from "lucide-react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// #389 / ADR-146: raw shadcn checkbox over Radix (role="checkbox" + aria-checked — never a styled div).
function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // #389the 1px frame is an inset ring, not a border, so the padding box and the border
        // box are the same rect — which is what lets the glyph below sit on exactly the box's own
        // edges instead of a rect inset by the border width.
        "peer shadow-[inset_0_0_0_1px_var(--border)] data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:shadow-[inset_0_0_0_1px_var(--accent)] focus-visible:ring-ring/50 relative size-4 shrink-0 rounded-[4px] transition-[color,box-shadow,background-color] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {/* #389the glyph box IS the box's rect (inset-0 against a padding box that the inset
          ring above leaves equal to the border box), so the two round to device pixels off the same
          edges. As a 14px icon centred in a 16px bordered box it was a rect at its own fractional
          offset, and the check drifted 1.5 device px between 100% and 125% zoom. The lucide viewBox
          carries the mark's own padding, so the check still reads at its old size. */}
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="absolute inset-0 text-current transition-none"
      >
        <CheckIcon className="size-full" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
