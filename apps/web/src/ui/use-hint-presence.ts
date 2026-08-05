import { useEffect, useRef, useState } from "react";
import { HINT_EXIT_MS, HINT_CLOSE_GRACE_MS } from "./hint-panel";

/** Keeps a hand-placed floating panel mounted long enough to animate its way out.
 *
 *  #630 (review rejection): the grace and the exit are two different things, and unifying only the
 *  first left the reader with two products again — a role name's panel faded away over 180ms while the
 *  Select hint and the group-roles list blinked off the moment their grace timer fired. Radix does this
 *  by flipping `data-state` to `closed` and unmounting after the animation; the hand-placed panels
 *  unmounted immediately, which was never a constraint, only what they happened to do.
 *
 *  Returns whether to render at all, plus the `data-state` the exit utilities key off — so a caller's
 *  own open/close logic (its delay, its grace, its pointer bookkeeping) is untouched: it keeps deciding
 *  WHEN a panel is open, and this decides how long the closed one lingers.
 *
 *  Re-opening during the exit cancels it rather than queuing a second one, which is the case that makes
 *  a nested hover usable — #603's walk crosses gaps that flip `open` off and back on within a frame or
 *  two, and a panel that insisted on finishing its exit would flicker under the pointer. */
export function useHintPresence(open: boolean): { present: boolean; state: "open" | "closed" } {
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // the previous `open`, so this reacts to the TRANSITION rather than to the value — mounting with
  // `open: false` must not schedule an exit for a panel that was never there
  const was = useRef(open);

  useEffect(() => {
    if (open) {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      setClosing(false);
    } else if (was.current) {
      setClosing(true);
      timer.current = setTimeout(() => { timer.current = null; setClosing(false); }, HINT_EXIT_MS);
    }
    was.current = open;
  }, [open]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { present: open || closing, state: open ? "open" : "closed" };
}

/** Wraps an open/close setter so CLOSING waits the shared grace and re-opening cancels it.
 *
 *  #630 (review rejection, second finding): the grace was thought to be shared and was not. Radix's
 *  ~182ms was its exit animation with no grace behind it; the hand-placed panels' ~172ms was a grace with
 *  no exit in front of it — two different behaviours that happened to sum alike, which is why a pin on
 *  the total span read them as agreeing. Giving the hand-placed panels their exit separated the numbers
 *  at once (397 against 234).
 *
 *  A CONTROLLED tooltip needs this explicitly: `TooltipRoot` supplies the same wait for the uncontrolled
 *  case, but it cannot delay a close its caller drives. The grace is what lets a pointer cross the gap
 *  between a trigger and the panel it raised — #603's walk — so it belongs to both. */
export function graced(
  set: (open: boolean) => void,
  timer: { current: ReturnType<typeof setTimeout> | null },
): (open: boolean) => void {
  return (open) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (open) return set(true);
    timer.current = setTimeout(() => { timer.current = null; set(false); }, HINT_CLOSE_GRACE_MS);
  };
}
