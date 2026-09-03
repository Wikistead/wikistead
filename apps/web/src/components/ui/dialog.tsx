import * as React from "react"
import { XIcon } from "lucide-react"
import { Dialog as DialogPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        // #1072/#939: NOT a close-animation on this layer. Radix's `Presence` waits for an
        // `animationend` before unmounting, and if that event is ever missed (interrupted animation,
        // React concurrent-render races), the `DismissableLayer` this overlay backs never unmounts —
        // leaving its `document.body.style.pointerEvents = "none"` lock applied forever, silently
        // swallowing the next click anywhere on the page. Dropping the exit animation makes the
        // unmount synchronous, closing that whole class of stuck-lock bug at the root.
        "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  overlayClassName,
  children,
  showCloseButton = true,
  position = "center",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean
  // Bump the overlay's z-index when this dialog is stacked ABOVE another open dialog
  // (e.g. a confirm shown over the permissions dialog), so it isn't drawn behind it.
  overlayClassName?: string
  // #344: "top" pins the dialog near the top (no vertical-centering translate) so a dialog whose height
  // changes with its content — a command palette's result list, a conditional warning line — grows DOWNWARD
  // and its top input field never shifts vertically (the "input jumps while typing" bug). Default "center"
  // is unchanged, so every existing dialog keeps centering.
  position?: "center" | "top"
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          // #365: keep a 4rem total (2rem/side) gutter so a dialog never reaches the screen edge. Set it via
          // WIDTH, not a narrow max-width: a per-dialog `sm:max-w-*` (e.g. the wide pickers' `sm:max-w-5xl`)
          // overrides the base max-width at `sm+`, so a base max-width cap can't hold the gutter for them at a
          // mid width (700–1000px, below 5xl). `w-[calc(100vw-4rem)]` is width, which the per-dialog max-widths
          // only CAP (never widen) — so the effective width is min(100vw-4rem, that dialog's max), giving every
          // #406 S3 / ADR-159 §3: below `sm` the gutter narrows to 2rem total (phones can't spare 64px).
          // dialog the gutter at narrow/mid widths while the `sm:max-w-*` maxima still govern on wide screens.
          // #1072/#939: see DialogOverlay's comment — same reasoning, this is the layer
          // `@radix-ui/react-dismissable-layer` actually gates on, so this is the one that matters.
          "fixed left-[50%] z-50 grid w-[calc(100vw-2rem)] sm:w-[calc(100vw-4rem)] translate-x-[-50%] gap-4 rounded-lg border bg-background p-6 shadow-lg duration-200 outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg",
          position === "top" ? "top-[10%] translate-y-0" : "top-[50%] translate-y-[-50%]", // #344: top-pin vs center
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
