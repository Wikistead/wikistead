import type React from "react";

// #639 (user ruling, 2026-08-06): list UIs are inconsistent — some are rows of boxes, some separate
// rows with rules. Unify on the latter, and share the UI as common components wherever possible.
//
// Four of the five boxed lists carried the SAME class string, character for character:
//
//   flex items-center gap-2.5 rounded-md border border-border px-2.5 py-2
//
// which is the ruling's own argument for a component — the shared idiom already existed, it was just
// being spread by copy rather than by import. The fifth spelled it differently (`p-2 text-sm`) and
// looked the same, which is how a copied idiom drifts.
//
// A row is separated from the next by a LINE, not by being its own box. The line goes on the row rather
// than between rows (`divide-y` needs the parent to own the list and breaks when a caller wraps its rows
// in anything), and the LAST row does not draw one — a trailing rule under the final item reads as a
// list that continues below the fold.
//
// `items-center` is deliberate and is the #586 lesson: rows in one list must be the same height, and a
// row whose content grows a line taller than its neighbour used to shift everything inside it. The last
// row's rule is made TRANSPARENT rather than removed for the same reason — measured, dropping the border
// made that one row 48px against its neighbours' 49, which is the uneven list #586 was about.

/** A row in an administrative list. Separated by a rule, not boxed. */
export function ListRow({ children, className = "", ...rest }: React.ComponentProps<"div">) {
  return (
    <div
      className={`flex items-center gap-2.5 border-b border-border px-1 py-2 last:border-transparent ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/** The box a list of `ListRow`s lives in: it grows with its content and scrolls only once it is tall.
 *
 *  `max-h`, never a fixed `h-` — the ruling is explicit (no box drawn by default; the list only becomes
 *  scrollable once it grows), and a fixed height gives a two-item list a mostly-empty frame. The height
 *  is the one five other lists already use rather than a sixth measurement invented here. */
export const LIST_SCROLL_MAX = "max-h-[26rem]";

export function ListBox({ children, className = "", ...rest }: React.ComponentProps<"div">) {
  return (
    <div className={`${LIST_SCROLL_MAX} overflow-y-auto ${className}`} {...rest}>
      {children}
    </div>
  );
}
