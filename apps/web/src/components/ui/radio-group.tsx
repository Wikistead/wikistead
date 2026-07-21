import * as React from "react"
import { RadioGroup as RadioGroupPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// #389 / ADR-146: raw shadcn radio-group over Radix. The DS wrapper (src/ui/RadioGroup.tsx) builds the
// segmented / list / card looks on top of these; this layer only carries the primitive + the standard
// circular item for ad-hoc use.
function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />
  )
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        // #389 the item paints its own dot (wks-radio-ring, ds-controls.css). Centering a
        // child dot — by translate (the shadcn default) or by flex — cannot help: a child is
        // its own paint box and rounds to device pixels separately from the ring, so at fractional
        // zoom the dot sits visibly low. Painting the dot as this element's background leaves one
        // box to round.
        "wks-radio-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 aspect-square size-4 shrink-0 rounded-full outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

// An item that renders its CHILDREN (no fixed circle) — the DS wrapper builds the segmented / list /
// card looks out of this (the item is the whole clickable row/segment; Radix still provides
// role="radio" + aria-checked + roving arrow-key focus).
function RadioGroupChoice({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return <RadioGroupPrimitive.Item data-slot="radio-group-choice" className={className} {...props} />
}

export { RadioGroup, RadioGroupItem, RadioGroupChoice }
