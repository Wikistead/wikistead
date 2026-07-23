import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/utils";

// Shared button (Group C-3: now Tailwind/cva instead of CSS Modules). Same API and
// variant vocabulary as before (default/primary/ghost/danger/dangerGhost · sm/md), so
// callers and e2e are unchanged. Colours resolve from the @theme tokens, so light/dark
// and the tenant accent cascade still apply. type defaults to "button" (a raw <button>
// defaults to "submit" — a frequent form footgun).
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border leading-none select-none cursor-pointer transition-[color,background-color,border-color,box-shadow,transform] duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] active:translate-y-[0.5px] disabled:opacity-50 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        default: "bg-panel-2 border-border text-foreground hover:bg-panel-3",
        primary: "bg-primary border-primary text-primary-foreground font-semibold hover:bg-[color-mix(in_srgb,var(--accent)_88%,black)] hover:shadow-sm",
        ghost: "bg-transparent border-transparent text-fg-dim hover:bg-panel-2 hover:text-foreground",
        danger: "bg-destructive border-destructive text-destructive-foreground font-semibold hover:bg-[color-mix(in_srgb,var(--danger)_85%,black)]",
        dangerGhost: "bg-transparent border-border text-destructive hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] hover:border-destructive",
      },
      size: {
        md: "text-sm px-3 py-1.5",
        sm: "text-xs px-[9px] py-1",
      },
    },
    defaultVariants: { variant: "default", size: "md" },
  },
);

type ButtonVariants = VariantProps<typeof buttonVariants>;

export function Button({
  variant,
  size,
  className,
  type = "button",
  children,
  ...rest
}: ButtonVariants & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...rest}>
      {children as ReactNode}
    </button>
  );
}

// Icon-only button (square, ghost). aria-label is required for accessibility.
// #504: `variant="danger"` is the shared destructive-icon treatment — text-destructive AT REST (the
// policy forbids "red only on hover"), with a danger-tinted hover wash. Every icon that triggers a
// destructive operation uses this instead of a per-site class.
export function IconButton({
  className,
  type = "button",
  variant = "default",
  children,
  ...rest
}: { "aria-label": string; variant?: "default" | "danger" } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center rounded-md border border-transparent bg-transparent p-1.5 leading-none cursor-pointer transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] disabled:opacity-50 disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        variant === "danger"
          ? "text-destructive hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] hover:text-destructive"
          : "text-fg-dim hover:bg-panel-2 hover:text-foreground",
        className,
      )}
      {...rest}
    >
      {children as ReactNode}
    </button>
  );
}
