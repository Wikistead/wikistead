import type { ReactNode } from "react";

/**
 * The fixed box a row's leading identity visual sits in.
 *
 * #625: one table holds person rows and group rows. A person's visual is a 24px avatar chip and a group's
 * is a 16px lucide icon, so with the same gap after it the two kinds of name started at different x — the
 * left edges of the VISUALS agreed (268 on both, measured) and the names did not.
 *
 * The icon is not grown to 24: a lucide glyph drawn at a filled chip's diameter reads much heavier than
 * the chip beside it. The BOX is what matches, and the glyph is centred in it at whatever size it reads
 * best. `ROW_LEAD_PX` is the one number, so the avatar's size and this box cannot drift apart — which is
 * the failure this replaces, in a slightly different form.
 */
export const ROW_LEAD_PX = 24;

export function RowLead({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden
      className="inline-flex flex-none items-center justify-center"
      style={{ width: ROW_LEAD_PX, height: ROW_LEAD_PX }}
    >
      {children}
    </span>
  );
}
