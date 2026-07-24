import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

// #530: the shadcn/Radix tooltip primitive. The native `title` attribute cannot be styled, cannot be
// themed, does not appear on keyboard focus, and its ~1–2s delay is browser-controlled — the reason this
// exists. Radix ships in the `radix-ui` umbrella we already depend on (same import shape as
// radio-group.tsx), so this adds NO dependency (ADR-011 licence gate untouched).
//
// The delay lives here so every tooltip in the app — React and the delegated DOM one (tooltip-host.ts) —
// shares one number. `--dur-base` (180ms) is the DS's "menus, dialogs" duration: fast enough to feel
// instant on purpose-driven hover, slow enough not to flash while the pointer crosses a toolbar.
export const TOOLTIP_DELAY_MS = 180

function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      // Closing is immediate (no grace period chaining between triggers): the complaint is about
      // waiting, and a lingering tooltip over the next control reads as lag too.
      skipDelayDuration={0}
      {...props}
    />
  )
}

function TooltipRoot({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // Surface tokens (light/dark follow automatically), a wrapping max-width the native tooltip
          // cannot offer, and the shared enter animation.
          "z-50 max-w-[min(22rem,90vw)] whitespace-normal break-words rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
          "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-popover" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

// The one-liner used at call sites: wrap the trigger, pass the text. `asChild` keeps the caller's own
// element as the trigger, so an icon button's `aria-label` (its ACCESSIBLE NAME) is untouched — the
// tooltip only adds `aria-describedby`. Never use this as a replacement for a label.
export function Tooltip({
  content,
  children,
  side,
  align,
  ...props
}: {
  content: React.ReactNode
  children: React.ReactNode
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>["align"]
} & Omit<React.ComponentProps<typeof TooltipPrimitive.Root>, "children">) {
  if (content == null || content === "") return <>{children}</>
  return (
    <TooltipRoot {...props}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align}>{content}</TooltipContent>
    </TooltipRoot>
  )
}

export { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent }
