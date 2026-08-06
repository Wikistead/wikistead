import * as React from "react"
import { Popover as PopoverPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// #641 / ADR-218: an overlay that holds real controls, as opposed to a tooltip that holds an
// explanation. Radix already carries what such a thing owes a keyboard — focus moves in on open and
// back to the trigger on close, Escape and an outside click dismiss it, and the panel is repositioned
// when it would leave the window. Writing those by hand is what #587's ruling calls "a new idiom",
// and that ruling exists because the hand-built radio group had to grow roving tabindex and arrow keys
// afterwards anyway.
//
// From the `radix-ui` umbrella, like every other primitive in this directory: the individual packages
// are in the lockfile but nothing imports them, so taking one directly would make this the odd file out.
function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        // #582/ #630: the same surface tokens and the same distance from the window edge every
        // other floating panel keeps. A second look for panels would be the drift those tickets closed.
        collisionPadding={8}
        className={cn(
          "z-50 rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
