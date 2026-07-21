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

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn("flex flex-none gap-1 overflow-x-auto border-b border-border", className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "-mb-px flex flex-none items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm text-fg-dim transition-colors",
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
function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("min-h-0 flex-1 overflow-y-auto pr-1 pt-3 focus-visible:outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
