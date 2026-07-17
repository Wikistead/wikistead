import type { ReactNode } from "react";

// #212: the ONE floating-toolbar toggle representation (vim / TOC / any future toggle).
// State is shown by FILL, not colour alone — WCAG 1.4.1 (colour is never the only cue):
//   pressed   = filled  (subtle accent background + accent border + accent icon/text)
//   unpressed = ghost   (transparent surface, hover panel)
// `aria-pressed` carries the state to assistive tech (the toggle-button pattern). Consolidated
// so vim/TOC (and later toggles) can't drift apart — same idea as RightPanel for the panels.
export function ToggleButton({ pressed, onToggle, icon, label, testId, text, badge, disabled }: {
  pressed: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;       // tooltip + aria-label
  testId: string;
  text?: string;       // optional visible label (e.g. "Vim"); omitted ⇒ icon-only round button
  badge?: ReactNode;
  disabled?: boolean;  // #406 S4: rendered but inert (e.g. vim on a coarse pointer) — the label explains why
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      data-testid={testId}
      data-active={pressed || undefined}
      disabled={disabled}
      onClick={onToggle}
      className={`pointer-events-auto relative inline-flex h-9 items-center justify-center gap-2 rounded-full border text-xs font-medium shadow-md backdrop-blur transition-colors duration-[120ms] ease-[cubic-bezier(0.2,0,0,1)] disabled:cursor-default disabled:opacity-50 ${
        text ? "px-3.5" : "w-9"
      } ${
        // #212 bounce: keep the SAME translucency as the toolbar panel (panel @ 82%) for BOTH states so
        // the label stays readable — the ON/OFF cue is the accent tint + border layered ON the panel, not
        // a see-through background. Pressed tints the panel with accent (still opaque); unpressed is the
        // plain panel. (The earlier accent@16%-on-transparent made ON almost fully see-through.)
        pressed
          ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_24%,color-mix(in_srgb,var(--panel)_82%,transparent))] text-[var(--accent)]"
          : "border-transparent bg-[color-mix(in_srgb,var(--panel)_82%,transparent)] text-foreground hover:bg-panel-2"
      }`}
    >
      {icon}
      {text && <span>{text}</span>}
      {badge}
    </button>
  );
}
