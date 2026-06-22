import type { ButtonHTMLAttributes, ReactNode } from "react";
import styles from "./Button.module.css";

type Variant = "default" | "primary" | "ghost" | "danger";
type Size = "sm" | "md";

// Shared, token-driven button (Phase 3b-2). Replaces raw <button> across the app so
// styling, theming, and (later) branding are consistent in one place. type defaults
// to "button" (raw <button> defaults to "submit", a frequent footgun in forms).
export function Button({
  variant = "default",
  size = "md",
  className,
  type = "button",
  children,
  ...rest
}: { variant?: Variant; size?: Size } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = [styles.btn, styles[size], variant !== "default" && styles[variant], className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {children as ReactNode}
    </button>
  );
}

// Icon-only button (square, ghost). aria-label is required for accessibility.
export function IconButton({
  className,
  type = "button",
  children,
  ...rest
}: { "aria-label": string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const cls = [styles.btn, styles.icon, className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {children as ReactNode}
    </button>
  );
}
