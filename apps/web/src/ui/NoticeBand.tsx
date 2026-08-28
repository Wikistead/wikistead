import type { ReactNode } from "react";
import { TriangleAlert, Info } from "lucide-react";

// #979 / ADR-268 §3, ruling (design B): the box that used to be `wks-left-bar` (a coloured left
// rule on a bare frame) — replaced with a tinted panel + leading icon + heading/body, the same shape
// callout-icons.css already draws for the editor's callout panel (ADR-268 §3.3: the two were the "same
// object with the paint stripped off one twin", which is the mechanism behind "looks off the shelf").
//
// `kind` is REQUIRED, on purpose (#873 / ruling the carried-over trap): the old `wks-left-bar`
// class fell back to `var(--accent)` (blue) when a caller forgot to set `--wks-left-bar-color`, so a
// danger notice with no colour override still painted SOMETHING plausible-looking and the omission
// went unnoticed for a whole ticket (#873). A required prop has no such fallback to reach — the ONLY
// way to get a NoticeBand with no declared kind is a TypeScript error, not a runtime default.
export type NoticeBandKind = "danger" | "info";

const ICON: Record<NoticeBandKind, typeof TriangleAlert> = { danger: TriangleAlert, info: Info };
// color-mix stays inline (not a new CSS class) — the six former call sites each already read the
// token from a class/style prop this way, so the panel keeps the exact colour-mix shape they used.
const TINT: Record<NoticeBandKind, string> = {
  danger: "color-mix(in srgb, var(--danger) 12%, var(--panel-2))",
  info: "color-mix(in srgb, var(--accent) 10%, var(--panel-2))",
};
const BORDER: Record<NoticeBandKind, string> = {
  danger: "color-mix(in srgb, var(--danger) 40%, var(--border))",
  info: "var(--border)",
};
const ICON_COLOR: Record<NoticeBandKind, string> = { danger: "var(--danger)", info: "var(--accent)" };

export function NoticeBand({
  kind,
  title,
  children,
  testId,
  role,
  className,
}: {
  kind: NoticeBandKind;
  title: ReactNode;
  children: ReactNode;
  testId?: string;
  /** #268 §3.1a: "alert" for something the reader must act on now, "status" for standing information. */
  role?: "alert" | "status";
  className?: string;
}) {
  const Icon = ICON[kind];
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg border px-3.5 py-3 ${className ?? ""}`}
      style={{ backgroundColor: TINT[kind], borderColor: BORDER[kind] }}
      data-testid={testId}
      data-notice-kind={kind}
      role={role}
    >
      <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0" style={{ color: ICON_COLOR[kind] }} />
      <div className="min-w-0">
        <div className="text-sm font-semibold" style={{ color: ICON_COLOR[kind] }}>{title}</div>
        <div className="mt-0.5 text-xs text-fg-dim">{children}</div>
      </div>
    </div>
  );
}
