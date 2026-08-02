import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "../components/ui/tooltip";
import { effectiveCaps } from "../settings/role-nouns";

// #586 / ADR-203 §2: a role name says what it lets someone do, without leaving the screen.
//
// The complaint this answers: "editor" reads as a role name or a permission name depending on who is
// looking, and the screens papered over it with sentences ("managers and moderators can always
// comment…"). Showing the actual list is the fix; the sentences go with it.
//
// Two decisions worth stating, because both were nearly got wrong
//
// The delegated `data-tip` tooltip renders ONE LINE of text (`tip.textContent = …`), so it cannot show
// a list. This uses the React tooltip, whose content is nodes.
//
// A Radix tooltip opens on hover and focus, and a coarse pointer has neither — `tooltip-host.ts`
// deliberately does not install on touch (ADR-159/#406). that only works with a mouse
// is not the feature, so the tooltip is CONTROLLED: hover and focus open it, and a tap toggles it. A
// trigger left uncontrolled closes itself on pointerdown, which on a tablet means the tap that should
// show it is the tap that hides it.
//
// The list is not a sentence (#585): no dash, no explanation of why a bundle is what it is.
export function RoleTip({
  children, builtinCapability, roleCapabilities, origin, testId,
}: {
  children: React.ReactNode;
  /** the wire capability a built-in row holds (its closure is looked up), if this is a built-in */
  builtinCapability?: string | null;
  /** a custom role's own capability list — a custom role IS its capabilities */
  roleCapabilities?: readonly string[] | null;
  /** #586 §1 (user ruling): the axis is ROLE vs INDIVIDUAL GRANT. Never built-in vs custom. */
  origin: "role" | "grant";
  testId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const caps = effectiveCaps({ builtinCapability, roleCapabilities });
  const label = t("roleTip.label", { caps: caps.map((c) => t(`adminRoles.cap.${c}`, c)).join(", ") });
  return (
    <Tooltip
      open={open}
      onOpenChange={setOpen}
      content={
        <div data-testid={testId ? `${testId}-content` : undefined}>
          <span className="block text-[11px] font-medium">
            {origin === "grant" ? t("roleTip.individual") : t("roleTip.role")}
          </span>
          <ul className="m-0 mt-1 list-none p-0">
            {caps.map((c) => (
              <li key={c} className="text-[11px]">{t(`adminRoles.cap.${c}`, c)}</li>
            ))}
          </ul>
        </div>
      }
    >
      {/* a span, not a button: these badges sit in rows that already carry actions, and a nested button
          would take a stop in the row's focus order away from the control that does something. tabIndex
          and the label make it reachable and readable; the click handler is what makes it work on touch. */}
      <span
        tabIndex={0}
        aria-label={label}
        data-testid={testId}
        data-origin={origin}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex cursor-help items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </span>
    </Tooltip>
  );
}
