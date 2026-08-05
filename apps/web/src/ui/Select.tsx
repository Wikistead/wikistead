import type React from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Select as SelectRoot, SelectTrigger, SelectValue, SelectContent, SelectItem } from "../components/ui/select";
import { useControlScale } from "./FormRow";

export interface SelectOption {
  value: string;
  label: string;
  /**
   * #586 / #582: what choosing this option would confer, shown when the option is POINTED AT or arrowed
   * onto — never printed under every label (nine two-line options made the reader read the whole
   * vocabulary before choosing one).
   *
   * #582 (review rejection, 2026-08-04): "…". It was a reveal INSIDE the
   * row, which reserved width for text nobody had asked for and read as part of the option. It is a
   * FLOATING panel now, raised beside the list — the same panel the row badges already show, handed in
   * by the caller so this component stays about selects.
   */
  hint?: React.ReactNode;
}

// DS select wrapper over shadcn/Radix Select. Drop-in for the common single-value
// pattern; keeps the stable trigger testid plus per-option testids
// (`${testId}-${value}`) so tests click the trigger then the option.
//
// #536Radix treats `value=` as "no value" — the item renders (and checks) in the OPEN list,
// but the CLOSED trigger shows nothing, so an empty-valued option's label ("member", the built-in fallback)
// vanished exactly where it matters. Callers keep the natural `` vocabulary; the wrapper maps it to a
// sentinel both ways so Radix always has a real value to resolve a label for.
const EMPTY_SENTINEL = "__wks-select-empty__";

export function Select({
  value, onChange, options, ariaLabel, disabled, testId, size,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  ariaLabel?: string;
  disabled?: boolean;
  testId?: string;
  size?: "sm" | "md";
}) {
  // #535: no `size` inside a FormRow means the row's scale; outside one it is the `md` it always was.
  const scale = useControlScale(size, "md");
  // #582: the open list is portalled to the body, and Radix keeps it inside the VIEWPORT — which says
  // nothing about the dialog the control lives in. A long option grew the list rightwards and carried it
  // out past the dialog's edge (measured 28px over, and outside it in the DOM), where a reader looking at
  // the dialog cannot follow it. Handing Radix the dialog as the boundary makes it shift or flip within
  // that box instead. Outside a dialog there is no boundary and the viewport rule applies, unchanged.
  const trigger = useRef<HTMLButtonElement>(null);
  const [boundary, setBoundary] = useState<Element | null>(null);
  // #582: which option is under the pointer or the arrow keys, and where its panel goes. Radix moves
  // `data-highlighted` rather than focus when the list is driven from the keyboard, so the highlight is
  // what is watched — a focus-based reveal never opens for a keyboard user.
  //
  // The panel is portalled to the body rather than rendered inside the list: the list box clips its own
  // overflow (that is what makes it scroll), so anything drawn beside an option inside it is cut off. A
  // Radix Tooltip raised from in here does not appear at all — the select is a modal layer and a tooltip
  // portalled out of it lands in the part of the document that layer has hidden — but a plain positioned
  // element above that layer does, which is what this is.
  // Only WHICH option is described lives in React state. Its POSITION is written straight onto the
  // portalled element below, because re-rendering on every move re-renders the option list with it
  // and Radix resets the keyboard highlight when its items re-render, so a held-down ArrowDown walked
  // one step and snapped back (measured: a 40-step walk never reached its target). Tracking the row was
  // the point of the #582 fix; doing it through state made the list unusable from the keyboard.
  const [hint, setHint] = useState<{ node: React.ReactNode } | null>(null);
  // the rendered panel, so its placement can use its real height instead of a constant that was a guess
  const panelRef = useRef<HTMLDivElement | null>(null);
  // where the panel goes, remembered across the render that mounts it (the element does not exist yet
  // when its position is computed, and a panel that paints once at 0,0 reads as a flicker)
  const pending = useRef<{ top: number; left: number } | null>(null);
  const [open, setOpen] = useState(false);
  // #582 (review rejection,/): the panel has to be readable BEFORE the list is opened — "what can
  // this person do" is the question the closed row already asks. The trigger raises the SAME panel, placed
  // by the SAME rule; a second implementation would be a second look, which is the thing this ticket keeps
  // saying not to build. The rule takes two rects because an option's panel sits beside the LIST but level
  // with its own ROW; for the trigger both are the trigger.
  const anchors = useRef<{ beside: DOMRect; align: DOMRect } | null>(null);
  const place = (beside: DOMRect, align: DOMRect) => {
    anchors.current = { beside, align };
    const width = 220;
    // beside it, and on the other side when there is no room — a panel off the screen edge is the same as
    // no panel
    const right = beside.right + 8;
    const left = right + width > window.innerWidth ? Math.max(8, beside.left - width - 8) : right;
    // #582 (review rejection): the panel belongs BESIDE the thing it describes, and it used to clamp to a
    // fixed `innerHeight - 120` — so every option below that line got a panel parked on the line instead
    // of next to itself (measured: 61px adrift at a 450px viewport, and invisible on short screens because
    // the constant was a guess at the panel's height, not its height).
    //
    // Now: start at the row, and move only if the panel would not fit, only as far as it must. The height
    // is MEASURED from the rendered panel — the first pass uses the row's own height as a floor, and every
    // later pass has the real number, so a taller panel corrects itself rather than being guessed forever.
    const panelH = panelRef.current?.offsetHeight ?? align.height;
    const top = Math.max(8, Math.min(align.top, window.innerHeight - 8 - panelH));
    pending.current = { top, left };
    if (panelRef.current) {
      panelRef.current.style.top = `${top}px`;
      panelRef.current.style.left = `${left}px`;
    }
  };
  const selected = options.find((o) => o.value === value);
  // Pointer movement, not just enter: after choosing an option the list closes under a pointer that never
  // left the trigger, and an enter-only reveal would stay dark until the reader moved away and back.
  // which value the trigger's panel is currently describing — pointermove fires constantly, and setting
  // state on each one re-renders the whole row under the pointer. Keyed by the value rather than "is
  // something shown", so a select whose value changes while the pointer rests on it updates instead of
  // keeping the panel of the role that is no longer there.
  const triggerKey = useRef<string | null>(null);
  const revealSelected = () => {
    if (open || disabled || !selected?.hint) return;
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    place(r, r);
    if (triggerKey.current === value) return; // already describing this one; the move above is enough
    triggerKey.current = value;
    setHint({ node: selected.hint });
  };
  const clearTriggerHint = () => { triggerKey.current = null; setHint(null); };
  useEffect(() => {
    if (!open) { clearTriggerHint(); return; }
    triggerKey.current = null; // the open list owns the panel from here
    // The list is found in the document rather than through a ref: it is portalled, it mounts after the
    // open, and only one select's list is open at a time. A ref would also have to survive the wrapper
    // chain between here and Radix's own content element, which is one more thing to be wrong.
    // The panel's own render mutates the body, so the watcher must not react to that or it feeds itself
    // attributes only, and a key that says "nothing changed" so an identical read does not re-render.
    let key = "";
    const read = () => {
      const box = document.querySelector<HTMLElement>("[data-slot=select-content]");
      // Two ways an option becomes "the one being looked at", and BOTH are needed. The keyboard moves
      // `data-highlighted`, which is why a focus-based reveal never opens for a keyboard user. The
      // pointer does not always produce that attribute — measured inside the page permissions dialog,
      // where an option sat under the pointer with nothing highlighted anywhere in the document — so
      // hover is read directly rather than trusted to Radix's bookkeeping.
      const item = box?.querySelector<HTMLElement>("[data-highlighted]") ?? box?.querySelector<HTMLElement>("[role=option]:hover");
      const o = item ? options.find((x) => x.value === (item.dataset.optionValue ?? "")) : undefined;
      if (!box || !item || !o?.hint) { if (key !== "") { key = ""; setHint(null); } return; }
      // beside the LIST, level with the OPTION's own row — the shared rule, so the open list and the
      // closed trigger cannot drift into two different placements. Position first, so the element is
      // already in the right place when it is (or stays) mounted.
      place(box.getBoundingClientRect(), item.getBoundingClientRect());
      if (o.value === key) return; // same option — the move above is all that was needed
      key = o.value;
      setHint({ node: o.hint });
    };
    read();
    // the list is portalled and mounts after the open, so give it a frame before giving up on it
    const frame = requestAnimationFrame(read);
    const obs = new MutationObserver(read);
    obs.observe(document.body, { attributes: true, subtree: true, attributeFilter: ["data-highlighted"] });
    // hover changes no attribute, so it is watched as what it is: pointer movement over the open list
    window.addEventListener("pointermove", read, true);
    return () => { cancelAnimationFrame(frame); obs.disconnect(); window.removeEventListener("pointermove", read, true); };
  }, [open, options]);
  return (
    <SelectRoot
      value={value === "" ? EMPTY_SENTINEL : value}
      onValueChange={(v) => { if (v != null) onChange(v === EMPTY_SENTINEL ? "" : v); }}
      disabled={disabled}
      // read on open, not on mount: the trigger may be mounted before the dialog around it exists
      onOpenChange={(isOpen) => { setOpen(isOpen); if (isOpen) setBoundary(trigger.current?.closest("[role=dialog]") ?? null); }}
    >
      <SelectTrigger
        ref={trigger}
        size={scale === "sm" ? "sm" : "default"}
        aria-label={ariaLabel}
        data-testid={testId}
        onPointerEnter={revealSelected}
        onPointerMove={revealSelected}
        // Only when closed: while the list is open the watcher above owns the panel, and clearing here
        // would blank it the moment the pointer crossed from the trigger onto the list.
        onPointerLeave={() => { if (!open) clearTriggerHint(); }}
      >
        {/* The trigger shows the LABEL, not the option's rendered children. Radix's default clones the
            selected item, which since #586 carries a hidden capability line — so the closed control held
            text nobody could see, reserved width for it, and handed it to anything reading the element.
            The label is what "the value" means here; the reveal belongs to the open list. */}
        <SelectValue>{options.find((o) => o.value === value)?.label ?? undefined}</SelectValue>
      </SelectTrigger>
      <SelectContent collisionBoundary={boundary ?? undefined} collisionPadding={8}>
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value === "" ? EMPTY_SENTINEL : o.value}
            data-testid={testId ? `${testId}-${o.value}` : undefined}
            // the highlight watcher reads this rather than the Radix value, which carries the empty
            // sentinel and would not match the caller's own vocabulary
            data-option-value={o.value}
          >
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
      {hint && createPortal(
        <div
          role="tooltip"
          data-testid={testId ? `${testId}-hint` : "select-hint"}
          className="pointer-events-none fixed z-[60] w-[220px] rounded-md border border-border bg-panel px-2 py-1.5 text-sm shadow-md"
          ref={(el) => {
            panelRef.current = el;
            // a freshly mounted panel has no position yet: place it on the thing that raised it before
            // the browser paints, or it flashes at the top-left corner
            if (el && pending.current) { el.style.top = `${pending.current.top}px`; el.style.left = `${pending.current.left}px`; }
            // …then place it again now that its real height can be measured. The open list re-runs its
            // watcher on every pointer move and corrects itself that way; a panel raised from the closed
            // trigger gets no second event, so without this it would keep the floor-height guess and a
            // tall panel would hang off a short viewport.
            if (el && anchors.current) place(anchors.current.beside, anchors.current.align);
          }}
        >
          {hint.node}
        </div>,
        document.body,
      )}
    </SelectRoot>
  );
}
