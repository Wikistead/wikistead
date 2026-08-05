import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { PANEL_EDGE } from "@/ui/panel-placement"

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
  portal = true,
  animated = true,
  // #582 (review rejection,): Radix keeps a tooltip on screen but defaults the distance from the edge
  // to zero, so a panel opening on a low row in a short window landed flush against the bottom — while
  // the panels placed by `panel-placement` stopped 8px short. One family, one distance.
  collisionPadding = PANEL_EDGE,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content> & { portal?: boolean; animated?: boolean }) {
  // #586: a tooltip on an option INSIDE an open Select must not be portalled to the body. A modal Radix
  // layer marks everything outside itself `aria-hidden`, and a tooltip that lands there is invisible to
  // the accessibility tree — measured: the content rendered and the a11y tree had no tooltip at all.
  // Rendered in place, it lives inside that layer and is announced with the option it describes.
  const Wrapper = portal ? TooltipPrimitive.Portal : React.Fragment
  return (
    <Wrapper>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          // Surface tokens (light/dark follow automatically), a wrapping max-width the native tooltip
          // cannot offer, and the shared enter animation.
          "z-50 max-w-[min(22rem,90vw)] whitespace-normal break-words rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
          // #582 (review rejection,①): the role panels appear on SIX surfaces and only this one
          // moved, because only this one is a Radix tooltip. A caller that belongs to that family opts
          // out here rather than fighting the classes from outside — the component owns the choice, and
          // an ordinary tooltip keeps the animation it has always had.
          animated && "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="fill-popover" />
      </TooltipPrimitive.Content>
    </Wrapper>
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
  portal,
  animated,
  ...props
}: {
  content: React.ReactNode
  children: React.ReactNode
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
  align?: React.ComponentProps<typeof TooltipPrimitive.Content>["align"]
  /** false inside another modal layer (an open Select) — see TooltipContent */
  portal?: boolean
  /** #582①: false for a panel that belongs to the un-animated role-explanation family */
  animated?: boolean
} & Omit<React.ComponentProps<typeof TooltipPrimitive.Root>, "children">) {
  if (content == null || content === "") return <>{children}</>
  return (
    <TooltipRoot {...props}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align={align} portal={portal} animated={animated}>{content}</TooltipContent>
    </TooltipRoot>
  )
}

export { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent }
