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

// …and the wait on the way out, for the same reason: `hint-panel` re-exports it as
// `HINT_CLOSE_GRACE_MS`, which is the name the rest of the app knows it by. It sits HERE rather than
// there because `hint-panel` already reads the open delay from this module, and having this file read
// the grace back from it would be a cycle — evaluated in the wrong order, one of the two constants is
// undefined at module load.
export const TOOLTIP_CLOSE_GRACE_MS = 160

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

// #630 (review rejection, second finding): the closing GRACE lives here too.
//
// The earlier round read the three implementations as agreeing on it — Radix ~182ms against the
// hand-placed ~172. They were not the same number: Radix's was its exit animation with no grace behind
// it, and the hand-placed panels' was a grace with no exit in front of it. Two different behaviours
// summing to the same total. Giving the hand-placed panels their exit made that visible immediately
// (340 against 180), which is the one useful thing about a pin that measures the whole span.
//
// So the grace is handed to this side as well: leaving waits, then the exit runs, on all four surfaces.
// It is what lets a pointer cross the gap between a trigger and the panel it raised — #603's walk — and
// re-entering inside the grace cancels the close rather than queuing a second one.
function TooltipRoot({ open, onOpenChange, ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [shown, setShown] = React.useState(false)
  const closing = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  React.useEffect(() => () => { if (closing.current) clearTimeout(closing.current) }, [])

  // a caller that drives `open` itself keeps doing so — this only supplies the behaviour for the
  // uncontrolled case, which is every tooltip in the product today
  const controlled = open !== undefined
  const change = (next: boolean) => {
    onOpenChange?.(next)
    if (controlled) return
    if (closing.current) { clearTimeout(closing.current); closing.current = null }
    if (next) setShown(true)
    else closing.current = setTimeout(() => { closing.current = null; setShown(false) }, TOOLTIP_CLOSE_GRACE_MS)
  }
  return <TooltipPrimitive.Root data-slot="tooltip" open={controlled ? open : shown} onOpenChange={change} {...props} />
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
  // #582 (review rejection): Radix keeps a tooltip on screen but defaults the distance from the edge
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
          // #582 ① let a caller opt OUT of the animation so the role panels could match the five
          // surfaces that had none. #630 reversed the direction — everything matches THIS — so the flag
          // survives only as a way to say "not this one", and nothing in the product passes it now.
          //
          // The pop, at the tokens' values. #630 briefly replaced it with a bare fade at `--dur-fast`
          // and the motion became invisible — a cross-fade that quick, on a panel the eye is already
          // resting on, reads as nothing happening.
          //
          // This uses tw-animate's enter/exit pair rather than the `.wks-pop` class the hand-placed
          // panels take, and the reason is measured, not stylistic: `.wks-pop` sets `animation` as a
          // SHORTHAND, which overrides the `animate-out` Radix drives through `data-[state=closed]` —
          // the tooltip then vanished with no exit at all (102ms against the 180 its siblings take).
          // The hand-placed panels unmount instead of animating out, so the shorthand costs them
          // nothing. Same keyframe values either way; `hint-timing-630` measures that they agree.
          animated && "animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 duration-[var(--dur-base)] ease-[var(--ease-out)]",
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
  /** #582 ①: false for a panel that belongs to the un-animated role-explanation family */
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
