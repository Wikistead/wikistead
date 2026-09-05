// @vitest-environment happy-dom
// #1132: a dropdown menu's own trigger, re-clicked while this content is still mounted for its close
// animation (data-state=closed, kept alive by @radix-ui/react-presence until animationend), lands the
// click on the real trigger element but the menu fails to reopen. Root cause (traced against the
// installed @radix-ui/react-dismissable-layer@1.1.13, @radix-ui/react-menu@2.1.18 and
// @radix-ui/react-use-controllable-state@1.2.3 sources, confirmed by instrumenting them directly, not
// guessed): a menu's trigger is never registered as a DismissableLayerBranch, so the still-mounted
// exiting layer's `pointerdown`-on-`document` listener treats the reopening click as an outside click
// and calls `onDismiss()` (an absolute `setOpen(false)`) via `ReactDOM.flushSync`. This app's
// DropdownMenu usages are all UNCONTROLLED (no `open` prop — see OverflowMenu.tsx/PageControls.tsx/
// PageTree.tsx, all `modal={false}` with no `open`), so `useControllableState` falls through to a
// plain internal `useState`: BOTH the trigger's own reopen toggle (`prev => !prev`, queued first) and
// the stale layer's absolute close (`false`, queued second, forced by `flushSync`) land as ordinary
// batched updates on the SAME state and apply in queue order — the toggle's `true` commits, then the
// dismiss's `false` overwrites it, netting closed. (A CONTROLLED harness — `open`+`onOpenChange`
// props — hits a completely different code path in `useControllableState`: it compares each proposed
// value against a stale closed-over `prop` before deciding whether to even call `onChange`, which
// happens to swallow the redundant-looking `false` and would make this pin falsely pass regardless of
// the fix. Confirmed by instrumentation before writing this — do not "simplify" this test back to a
// controlled harness.)
//
// This is not a CSS/animation-duration race: it reproduces with zero animation, driven purely by
// event-propagation and batching order, which is why this pin drives it with `forceMount` (content
// deliberately kept mounted while the internal state is already closed) instead of any wall-clock
// delay — deterministic, no flake budget needed. `forceMount` must be threaded to BOTH the Portal and
// the Content (see the DropdownMenuContent fix in dropdown-menu.tsx) — react-menu's `MenuPortal` has
// its OWN independent `present` gate keyed off `context.open`, so forceMount on Content alone renders
// nothing (confirmed the hard way — this pin previously false-passed for that reason too).
//
// #1120's fix (`[data-slot="dialog-content"][data-state="closed"] { pointer-events: none }`) does not
// apply here: non-modal dropdown/menu content never gets a body pointer-events lock or overlay, and
// the ticket's own real-Chromium measurement confirmed the click physically lands on the trigger
// (`elementFromPoint` returns the real page element) — this is a state-clobber, not a hit-test miss.
//
// No @testing-library/react in this package — real react-dom/client rendering + real DOM event
// dispatch, matching this ticket's own measurement note that Radix menus open on `pointerdown`, not
// `click` (`locator.click()`'s actionability wait was observed to hide this exact defect class).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as React from "react";
import { createElement, act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";

function Harness(): ReactNode {
  // Deliberately UNCONTROLLED (no `open`/`onOpenChange` props) — matches every real call site.
  return createElement(
    DropdownMenu,
    { defaultOpen: false },
    createElement(
      DropdownMenuTrigger,
      { "data-testid": "trigger" } as React.ComponentProps<typeof DropdownMenuTrigger>,
      "⋯"
    ),
    // forceMount: keep the content (and its DismissableLayer) mounted regardless of `open`,
    // deterministically reproducing the "data-state=closed but still mounted" window that a real
    // browser only holds open for the ~180ms close animation.
    createElement(
      DropdownMenuContent,
      { forceMount: true, "data-testid": "content" } as React.ComponentProps<typeof DropdownMenuContent>,
      createElement(DropdownMenuItem, {}, "Item")
    )
  );
}

function dispatchRealClick(el: Element): void {
  const base = { bubbles: true, cancelable: true, composed: true, button: 0 } as const;
  el.dispatchEvent(new PointerEvent("pointerdown", base));
  el.dispatchEvent(new MouseEvent("mousedown", base));
  el.dispatchEvent(new PointerEvent("pointerup", base));
  el.dispatchEvent(new MouseEvent("mouseup", base));
  el.dispatchEvent(new MouseEvent("click", base));
}

// Radix's outside-pointerdown listener attaches to `document` via a `setTimeout(0)` (to avoid
// treating the very click that opened a layer as an immediate outside click) — real macrotask, not a
// microtask, so tests must let it elapse before dispatching the probing click.
function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  // Radix's DismissableLayer listens on `ownerDocument` (real `document`) for outside pointerdown —
  // the dispatched click must actually bubble that far, which requires the container to be attached.
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe("#1132: a trigger re-click during the exiting content's still-mounted window reopens the menu", () => {
  it("the trigger's toggle wins over the exiting layer's stale outside-pointerdown dismiss", async () => {
    await act(async () => { root = createRoot(container); root.render(createElement(Harness)); });
    await flushMacrotask();
    await flushMacrotask();

    const trigger = container.querySelector('[data-testid="trigger"]');
    expect(trigger, "trigger must render").not.toBeNull();
    expect(trigger!.getAttribute("data-state"), "starts closed").toBe("closed");

    await act(async () => { dispatchRealClick(trigger!); });

    expect(
      trigger!.getAttribute("data-state"),
      "the reopening click must not be clobbered by the stale exiting layer's outside-dismiss"
    ).toBe("open");
  });

  it("a click genuinely outside both trigger and content still dismisses normally (no regression)", async () => {
    await act(async () => { root = createRoot(container); root.render(createElement(Harness)); });
    await flushMacrotask();
    await flushMacrotask();

    const trigger = container.querySelector('[data-testid="trigger"]');
    await act(async () => { dispatchRealClick(trigger!); });
    expect(trigger!.getAttribute("data-state"), "opened by the first click").toBe("open");

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      await act(async () => { dispatchRealClick(outside); });
      expect(trigger!.getAttribute("data-state"), "a real outside click still dismisses").toBe("closed");
    } finally {
      outside.remove();
    }
  });
});
