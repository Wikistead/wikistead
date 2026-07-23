import * as React from "react"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// #460 / ADR-174: tabs over Radix — real role="tab"/"tabpanel" semantics with arrow-key roving focus,
// so a keyboard reaches every panel and a screen reader is told which one it is in. The strip scrolls
// sideways rather than wrapping or shrinking: on a phone the dialog stays bounded (ADR-159 keeps the
// full-screen sheet off the table), and a strip that wraps would eat the height the panel needs.
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" className={cn("flex min-h-0 flex-1 flex-col", className)} {...props} />
}

// #460 the strip must never grow its OWN scrollbar. `overflow-x-auto` forces overflow-y to
// `auto` too (a non-visible axis autos the other), and the old `-mb-px` on each trigger pushed the
// underline 1px past the strip's content box — a 1px vertical scroll range, i.e. a tiny permanent
// scrollbar. So the divider (border-b) moves OUT to a plain wrapper, and the Radix list is the
// scroller (`overflow-y-hidden` kills the vertical axis for good). The 1px underline overlap is now
// the SCROLLER's job (-mb-px on it, nothing inside overflows): its bottom row paints over the
// wrapper's border, so the active underline still fuses with the divider — one line, no bar.
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <div data-slot="tabs-list-frame" className="flex-none border-b border-border">
      <TabsPrimitive.List
        data-slot="tabs-list"
        className={cn("-mb-px flex gap-1 overflow-x-auto overflow-y-hidden", className)}
        {...props}
      />
    </div>
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "flex flex-none items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-fg-dim transition-colors",
        "hover:text-foreground focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]",
        "data-[state=active]:border-[var(--accent)] data-[state=active]:text-foreground data-[state=active]:font-medium",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  )
}

// The panel is the scroller (ADR-174): the dialog body used to be one long scroll, so the header, the
// tab strip and Close scrolled away with it. Only the active panel mounts, which is also what keeps a
// hidden panel from being asserted as "not visible" in a test — it is simply not there.
// #460 ③: `overflow-y-auto` makes the panel clip the x-axis too (a non-visible axis forces the
// other to `auto`), so a focus ring on a control flush to the panel's left edge lost its outer 3px. The
// scroller gets padding on BOTH sides (px-1) — the ring lands inside the padding box, never clipped.
function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("min-h-0 flex-1 overflow-y-auto px-1 pb-2 pt-3 focus-visible:outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
