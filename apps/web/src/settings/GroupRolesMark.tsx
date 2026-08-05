import type React from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChevronRight, Users } from "lucide-react"; // #544: an icon component, never a text glyph
import { RoleCaps } from "../ui/RoleTip";
import { placeBelow, placeBeside, type At } from "../ui/panel-placement";
import { HINT_PANEL, HINT_PANEL_W, HINT_PANEL_ANIM, HINT_OPEN_DELAY_MS, HINT_CLOSE_GRACE_MS } from "../ui/hint-panel";
import { useHintPresence } from "../ui/use-hint-presence";
import { TENANT_TIER_CAPS } from "./role-nouns";
import type { GroupConferredRole } from "./tenant-role-rows";

/** What a conferred role lets someone do, resolved the ONE way the rest of this screen resolves it.
 *  A tenant built-in is a TIER, and a tier's capabilities depend on the tenant's own member defaults —
 *  `effectiveCaps` has no table for tenant scope on purpose (it would have to guess). So the caller's
 *  measured tier caps come in, and nothing here invents a second answer. */
type TierCaps = { member?: readonly string[] };
const capsOf = (g: GroupConferredRole, tierCaps: TierCaps): readonly string[] | null =>
  g.builtin ? (g.builtin === "admin" ? TENANT_TIER_CAPS.admin : tierCaps.member ?? null) : g.capabilities ?? null;

// #603 (user ruling, 2026-08-05): what a member's GROUPS confer, folded into one mark.
//
// The shape this replaces was a badge per (role, group) stacked above the row's Select. It was itself a
// tooltip " — and it got worse with each group: 57px against 41px for every other
// row with ONE badge, more with two.
//
// So: one mark beside the control, carrying the COUNT (how many there are is readable before you point
// at it), and a hover list of group × role. Capabilities are deliberately NOT in that list — a member in
// five groups would grow a panel taller than the page. The role NAME inside the list raises the same
// capability panel every other role name raises (#582), which is why the list must be able to receive
// the pointer: `pointer-events-none` on it would kill the walk from the mark into the list and onto a
// name. It stays open while the pointer is anywhere in that chain.
//
// #603 (user ruling, 2026-08-05): "1 ". Both panels place themselves
// through the shared rule in `panel-placement`, which flips to whichever side has room and clamps the
// other axis. Measured before: the list ran off the bottom at a 420px-tall window and the capability
// panel off the right at a 1000px-wide one, because each wrote `top`/`left` from its anchor and never
// asked about the viewport. The size a panel needs is only known once it is rendered, so each measures
// itself in a layout effect and places again — a guessed constant is what put the old panel 61px adrift.

/** Placement state that settles, and says whether it has been measured yet.
 *
 *  A panel cannot be measured until it is rendered, so the first pass necessarily places it from a
 *  height of zero — and traced on the device, that first answer put the capability panel's bottom at
 *  437 in a 420px window before the second pass moved it to 412. Correct within a frame, and visibly
 *  wrong for that frame. So the panel is rendered TRANSPARENT until a pass that had something to
 *  measure: it takes up space (which is how it gets measured) and shows nothing until it is where it
 *  belongs. Writing the same answer twice is a no-op, so measuring from a ref callback converges. */
function useSettledAt(): [At | null, boolean, (next: At, measured: boolean) => void] {
  const [at, setAt] = useState<At | null>(null);
  const [measured, setMeasured] = useState(false);
  const put = (next: At, didMeasure: boolean) => {
    setAt((prev) => (prev && prev.top === next.top && prev.left === next.left ? prev : next));
    if (didMeasure) setMeasured(true);
  };
  return [at, measured, put];
}

export function GroupRolesMark({ roles, tierCaps }: { roles: readonly GroupConferredRole[]; tierCaps: TierCaps }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [at, measured, setAt] = useSettledAt();
  // #630 mounted through its exit, so it fades the way the Radix tooltip beside it does rather
  // than blinking off the moment the grace timer fires.
  const presence = useHintPresence(open);
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  // one timer for the whole chain: leaving the mark for the list (or the list for a role name) crosses a
  // gap of a few pixels, and closing on that gap is what makes a nested hover impossible to use
  const closing = useRef<ReturnType<typeof setTimeout> | null>(null);
  // #630: the same delay every other floating explanation waits — a panel that appears the instant the
  // pointer crosses it fires on the way past whatever the reader was actually going to. Cancelled if the
  // pointer leaves first, and skipped when the panel is already open (re-entering from the list must not
  // re-queue it). Declared here, above the early return below, because it is a hook.
  const opening = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (roles.length === 0) return null;

  const show = () => {
    if (closing.current) { clearTimeout(closing.current); closing.current = null; }
    if (open) { place(); return; }
    if (opening.current) return;
    opening.current = setTimeout(() => {
      opening.current = null;
      place();
      setOpen(true);
    }, HINT_OPEN_DELAY_MS);
  };
  const cancelOpen = () => {
    if (opening.current) { clearTimeout(opening.current); opening.current = null; }
  };
  /** Measured when the panel exists, estimated from the anchor for the frame before it does.
   *
   *  `offsetWidth`/`offsetHeight`, NOT `getBoundingClientRect()` — #630 gave these panels an entrance
   *  that scales from 95%, and a client rect is the box AFTER transform. Measured during the animation
   *  it reports 95% of the real height, the placement clamps against a panel smaller than the one that
   *  lands, and the second tier hung off the bottom at a 700px viewport (the #603 pin caught it). The
   *  layout box is what the panel will occupy once it has finished arriving. */
  const place = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const box = panel.current;
    setAt(placeBelow(r, { width: box?.offsetWidth ?? 0, height: box?.offsetHeight ?? 0 }), !!box);
  };
  // The first pass had no panel to measure; this one does, so a list that would have hung off the bottom
  // flips above on the frame it appears rather than after the reader has already seen it clipped.
  useLayoutEffect(() => { if (open) place(); }, [open, at, roles.length]);
  const hide = () => {
    cancelOpen();
    if (closing.current) clearTimeout(closing.current);
    closing.current = setTimeout(() => setOpen(false), HINT_CLOSE_GRACE_MS);
  };

  return (
    <>
      <span
        ref={anchor}
        tabIndex={0}
        data-testid="group-roles-mark"
        aria-label={t("members.groupRolesMark", { count: roles.length })}
        className="ml-2 inline-flex cursor-help items-center gap-1 rounded border border-[var(--accent)] px-1 text-[11px] text-[var(--accent)] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocus={show}
        onBlur={hide}
        // touch has no hover (ADR-159): a tap toggles, like every other mark in this family — and it
        // opens AT ONCE rather than after the hover delay, since waiting 180ms after a deliberate tap
        // reads as an unresponsive control.
        onClick={() => { cancelOpen(); place(); setOpen((o) => !o); }}
      >
        <Users size={12} aria-hidden />
        {roles.length}
      </span>
      {presence.present && at && createPortal(
        <div
          ref={(el) => { panel.current = el; if (el) place(); }}
          role="tooltip"
          data-role-panel
          data-state={presence.state}
          data-testid="group-roles-list"
          className={`fixed z-[60] w-max max-w-[320px] ${HINT_PANEL} ${measured ? HINT_PANEL_ANIM : "opacity-0"}`}
          style={{ top: at.top, left: at.left }}
          onPointerEnter={show}
          onPointerLeave={hide}
        >
          <span className="block text-[11px] font-medium">{t("members.groupRolesTitle")}</span>
          <ul className="m-0 mt-1 list-none p-0">
            {roles.map((g) => (
              <li key={`${g.role}@${g.group}`} className="flex items-baseline gap-2 text-[11px]">
                <span className="text-fg-dim">{g.group}</span>
                {/* the role NAME is the nested hover: it raises the capability panel #582 settled on, so
                    this list carries two axes and no third way of showing what a role can do */}
                <RoleNameWithCaps role={g} caps={capsOf(g, tierCaps)} list={panel} />
              </li>
            ))}
          </ul>
        </div>,
        document.body,
      )}
    </>
  );
}

/** A role name in the list, with the shared capability panel on its own hover.
 *
 *  The panel is placed beside the LIST, not beside the name: level with the name it describes, but clear
 *  of the list it came from. Anchoring it to the name put it 46px on top of the list (#603), so
 *  looking up what a role can do hid the other roles — in the one panel whose whole purpose is comparing
 *  them. That is exactly the two-rect case `placeBeside` exists for, and the same one an open Select uses.
 *
 *  The chevron is the ruling's fourth point: the second tier was there but nothing said so, and a
 *  hover nobody knows about is a hover nobody uses. */
function RoleNameWithCaps({ role, caps, list }: {
  role: GroupConferredRole;
  caps: readonly string[] | null;
  list: React.RefObject<HTMLDivElement | null>;
}) {
  const [open, setOpen] = useState(false);
  const [at, measured, setAt] = useSettledAt();
  const presence = useHintPresence(open);
  const ref = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    // the layout box again, for the reason `place` above spells out
    const box = panel.current;
    setAt(placeBeside(list.current?.getBoundingClientRect() ?? r, r, { width: 220, height: box?.offsetHeight ?? 0 }), !!box);
    setOpen(true);
  };
  useLayoutEffect(() => { if (open) place(); }, [open, at]);
  return (
    <>
      <span
        ref={ref}
        tabIndex={0}
        data-testid="group-role-name"
        className="inline-flex cursor-help items-center gap-0.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onPointerEnter={place}
        onPointerLeave={() => setOpen(false)}
        onFocus={place}
        onBlur={() => setOpen(false)}
      >
        {role.role}
        <ChevronRight size={11} aria-hidden className="text-fg-dim" />
      </span>
      {presence.present && at && createPortal(
        <div
          ref={(el) => { panel.current = el; if (el) place(); }}
          role="tooltip"
          data-state={presence.state}
          data-testid="group-role-caps"
          className={`pointer-events-none fixed z-[70] ${HINT_PANEL_W} ${HINT_PANEL} ${measured ? HINT_PANEL_ANIM : "opacity-0"}`}
          style={{ top: at.top, left: at.left }}
        >
          <RoleCaps origin="role" scope="tenant" roleCapabilities={caps} />
        </div>,
        document.body,
      )}
    </>
  );
}
