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
// #536 Radix treats `value=` as "no value" — the item renders (and checks) in the OPEN list,
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
  const [hint, setHint] = useState<{ node: React.ReactNode; top: number; left: number } | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) { setHint(null); return; }
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
      const list = box.getBoundingClientRect();
      const row = item.getBoundingClientRect();
      const width = 220;
      // beside the list, and on the other side when there is no room — a panel off the screen edge is
      // the same as no panel
      const right = list.right + 8;
      const left = right + width > window.innerWidth ? Math.max(8, list.left - width - 8) : right;
      const top = Math.min(row.top, window.innerHeight - 120);
      const next = `${o.value}:${Math.round(top)}:${Math.round(left)}`;
      if (next === key) return;
      key = next;
      setHint({ node: o.hint, top, left });
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
      <SelectTrigger ref={trigger} size={scale === "sm" ? "sm" : "default"} aria-label={ariaLabel} data-testid={testId}>
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
          className="pointer-events-none fixed z-[60] w-[220px] rounded-md border border-border bg-panel px-2 py-1.5 shadow-md"
          style={{ top: hint.top, left: hint.left }}
        >
          {hint.node}
        </div>,
        document.body,
      )}
    </SelectRoot>
  );
}
