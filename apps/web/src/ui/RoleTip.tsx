import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "../components/ui/tooltip";
import { effectiveCaps } from "../settings/role-nouns";
import { graced } from "./use-hint-presence";

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
   * Where this name is drawn. A BADGE carries its own focus stop and tap toggle; a CONTROL wraps a Select
   * and lets the control inside own both.
   *
   * #582 (review rejection, 2026-08-04): the third mode — an OPTION that revealed its capabilities INSIDE the
   * row — is gone. The ruling asked for a floating panel like the badge's, and `ui/Select` now raises one
   * for whichever option is highlighted, using `RoleCaps` below. One design, two hosts.
   */
  as?: "badge" | "control";
  /** #586 review ①: WHICH measured table answers. A space row holds a composite noun, a page row a
   *  single arm, and they confer different things — a page `edit` grant cannot comment. */
  scope?: "space" | "page" | "tenant";
  testId?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closing.current) clearTimeout(closing.current); }, []);
  const anchor = useRef<HTMLSpanElement>(null);
  // #578 bounce ③: a row whose role is CHANGED in place wraps a Select, not a badge. Same tooltip, same
  // origin colour, but the control inside owns the focus stop and the click — taking either would make
  // choosing a role a two-step affair and put a second tab stop in front of it.
  const control = as === "control";
  const option = false; // the in-row option mode is retired (see `as` above)
  const caps = effectiveCaps({ builtinCapability, roleCapabilities, scope });
  const label = t("roleTip.label", { caps: caps.map((c) => t(`adminRoles.cap.${c}`, c)).join(", ") });
  // An OPTION reveals in place instead of in a tooltip. Measured, not preferred: a Radix tooltip raised
  // from inside an open Radix Select never appears — the select is a modal layer, and a tooltip portalled
  // out of it lands in the part of the document that layer has hidden. Rendering it inside the option
  // keeps the behaviour the ruling asked for (the name at rest, what it confers when you point at it)
  // without a floating layer fighting another one. Hover and the arrow-key highlight both reveal it,
  // because Radix moves `data-highlighted` rather than focus when the list is driven from the keyboard.
  return (
    <Tooltip
      open={open}
      // #630this one is CONTROLLED (a tap toggles it, see the note at the top), so the closing
      // grace `TooltipRoot` supplies for the uncontrolled case never reached it — measured, this panel
      // left after 234ms while the hand-placed ones took 397. `graced` runs the same wait before the
      // close, and cancels it if the pointer comes back, so all four surfaces leave the same way.
      onOpenChange={graced(setOpen, closing)}
      // #582① made this panel opt OUT of the animation, to match the five surfaces that had
      // none. #630 reverses that: the ruling picks the app's ordinary tooltip as what everything
      // matches, so this one keeps the default and the hand-placed panels gained the same entrance.
      // #582 (ruling 2026-08-05): ONE kind of panel, and it is the one that comes out at the SIDE. The
      // badges used to raise this at the top-left while `ui/Select` raised its own to the right, so the
      // same information arrived in two places depending on what the pointer happened to be over. Same
      // side, same width (RoleCaps below), so the reader learns one shape.
      side="right"
      align="start"
      content={<RoleCaps origin={origin} scope={scope} builtinCapability={builtinCapability} roleCapabilities={roleCapabilities} testId={testId} />}
    >
      {/* a span, not a button: these badges sit in rows that already carry actions, and a nested button
          would take a stop in the row's focus order away from the control that does something. tabIndex
          and the label make it reachable and readable; the click handler is what makes it work on touch. */}
      <span
        ref={anchor}
        tabIndex={option || control ? undefined : 0}
        // Only on a badge. Inside a listbox the span's label BECOMES the option's accessible name, so
        // labelling it with the capability list renamed every option after what it confers — measured
        // the option "editor" announced itself as "Can: View, Edit, Publish". The option keeps its name;
        // Radix links the tooltip as its description.
        aria-label={option || control ? undefined : label}
        data-testid={testId}
        data-origin={origin}
        // Not on an option: the click there IS the selection, and swallowing it to toggle a tooltip
        // would make picking a role a two-tap affair.
        onClick={option || control ? undefined : () => setOpen((o) => !o)}
        className={control
          // the origin reads off the control itself: a role-derived row wears the accent the role badges
          // wore, an individually granted one stays neutral. Tokens only (#586 §1: never a hex here).
          ? "inline-flex items-center data-[origin=role]:[&_button]:border-[var(--accent)] data-[origin=role]:[&_button]:text-[var(--accent)]"
          : "inline-flex cursor-help items-center outline-none focus-visible:ring-2 focus-visible:ring-ring"}
      >
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * The PANEL: a heading that says where the capabilities come from, and the capabilities under it, one
 * per line.
 *
 * #582 (review rejection, 2026-08-04): "
 * ". The badge tooltip was already exactly that,
 * so the option hint is the SAME component in a different host rather than a second design — which is
 * what the in-place reveal it replaces had become.
 */
export function RoleCaps({
  builtinCapability, roleCapabilities, origin, scope, testId,
}: {
  builtinCapability?: string | null;
  roleCapabilities?: readonly string[] | null;
  origin: "role" | "grant";
  scope?: "space" | "page" | "tenant";
  testId?: string;
}) {
  const { t } = useTranslation();
  const caps = effectiveCaps({ builtinCapability, roleCapabilities, scope });
  return (
    // #582 (ruling 2026-08-05): the same 220px box the select raises, and text that follows the settings
    // body rather than the browser default — the panel inherited 16px from <body> (a missing size, not a
    // choice), which read as larger than everything around it.
    // #582the FAMILY is named in the product, the way #589 named the sign-in rows — a pin that
    // walks "every panel explaining a role" has to know which panels those are, and inferring it from a
    // shared affordance swept up unrelated tooltips (a status icon's label is not one of these).
    <div data-role-panel className="w-[220px] text-sm" data-testid={testId ? `${testId}-content` : undefined}>
      <span className="block text-[11px] font-medium">
        {origin === "grant" ? t("roleTip.individual") : t("roleTip.role")}
      </span>
      <ul className="m-0 mt-1 list-none p-0">
        {caps.map((c) => (
          <li key={c} className="text-[11px]">{t(`adminRoles.cap.${c}`, c)}</li>
        ))}
      </ul>
    </div>
  );
}
