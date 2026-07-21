import * as React from "react"
import { Switch as SwitchPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// #389 / ADR-146: raw shadcn switch over Radix (role="switch" + aria-checked; knob position is the
// non-colour state cue). Track uses the accent when on, --panel-2 via the muted token when off.
//
// #389the track PAINTS its own knob (wks-switch, ds-controls.css) and the geometry is whole
// even numbers — 36×20 track, 16px knob, 2px of air all round, 16px of travel. The shadcn default
// was a 1.15rem (18.4px) track around a 16px thumb, which left 0.2px of air on a fractional height:
// the knob looked jammed against the track at every zoom, and being a separate paint box it also
// rounded to device pixels independently of the track (up to 1 device px off the centre line at
// 150%). Background-position moves the knob, so nothing carries a resting transform.
function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "wks-switch peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-[var(--panel-3)] focus-visible:ring-ring/50 inline-flex h-5 w-9 shrink-0 rounded-full shadow-xs outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Switch }
