import { useRef, useState } from "react";
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
  children, builtinCapability, roleCapabilities, origin, scope, testId, as = "badge",
}: {
  children: React.ReactNode;
  /** the wire capability a built-in row holds (its closure is looked up), if this is a built-in */
  builtinCapability?: string | null;
  /** a custom role's own capability list — a custom role IS its capabilities */
  roleCapabilities?: readonly string[] | null;
  /** #586 §1 (user ruling): the axis is ROLE vs INDIVIDUAL GRANT. Never built-in vs custom. */
  origin: "role" | "grant";
  /**
   * Where this name is drawn. A BADGE sits in a row and carries its own focus stop and tap toggle. An
   * OPTION sits inside an open dropdown, where both of those would be wrong: the option already owns the
   * click (it is the choice) and Radix keeps focus on the list rather than on the item, so the tooltip
   * follows the item's HIGHLIGHT instead — which is what a keyboard user moves with the arrow keys.
   */
  as?: "badge" | "option";
  /** #586 review ①: WHICH measured table answers. A space row holds a composite noun, a page row a
   *  single arm, and they confer different things — a page `edit` grant cannot comment. */
  scope?: "space" | "page" | "tenant";
  testId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const option = as === "option";
  const [hovered, setHovered] = useState(false);
  const caps = effectiveCaps({ builtinCapability, roleCapabilities, scope });
  const label = t("roleTip.label", { caps: caps.map((c) => t(`adminRoles.cap.${c}`, c)).join(", ") });
  const capsList = caps.map((c) => t(`adminRoles.cap.${c}`, c)).join(", ");
  // An OPTION reveals in place instead of in a tooltip. Measured, not preferred: a Radix tooltip raised
  // from inside an open Radix Select never appears — the select is a modal layer, and a tooltip portalled
  // out of it lands in the part of the document that layer has hidden. Rendering it inside the option
  // keeps the behaviour the ruling asked for (the name at rest, what it confers when you point at it)
  // without a floating layer fighting another one. Hover and the arrow-key highlight both reveal it,
  // because Radix moves `data-highlighted` rather than focus when the list is driven from the keyboard.
  if (option) {
    return (
      <span
        ref={anchor}
        data-origin={origin}
        // React's own handlers, on the element this component owns. Listeners attached to the Radix item
        // and a `:hover` rule on it were both measured NOT to reveal anything, even with the option
        // genuinely hovered — the item is Radix's, and what it does to it between renders is Radix's
        // business. This span is ours.
        onPointerEnter={() => setHovered(true)}
        onPointerMove={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        className="inline-flex items-center gap-2"
      >
        <span>{children}</span>
        {/* always present so the option does not resize when it reveals (a growing row moves itself out
            from under the pointer); hidden until asked for, so the list reads as names. */}
        <span
          data-testid={testId ? `${testId}-caps` : "role-option-caps"}
          className="wks-role-caps text-[10px] text-fg-dim"
          style={{ visibility: hovered ? "visible" : undefined }}
        >
          {capsList}
        </span>
      </span>
    );
  }
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
        ref={anchor}
        tabIndex={option ? undefined : 0}
        // Only on a badge. Inside a listbox the span's label BECOMES the option's accessible name, so
        // labelling it with the capability list renamed every option after what it confers — measured
        // the option "editor" announced itself as "Can: View, Edit, Publish". The option keeps its name;
        // Radix links the tooltip as its description.
        aria-label={option ? undefined : label}
        data-testid={testId}
        data-origin={origin}
        // Not on an option: the click there IS the selection, and swallowing it to toggle a tooltip
        // would make picking a role a two-tap affair.
        onClick={option ? undefined : () => setOpen((o) => !o)}
        className="inline-flex cursor-help items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </span>
    </Tooltip>
  );
}
