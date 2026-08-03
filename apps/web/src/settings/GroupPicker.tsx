// #578 / ADR-201 slice 6, then the bounce: naming a group, once, in one control.
//
// Both surfaces that confer a role on an IdP group — the space Members tab and the tenant Roles tab
// need the same control, and the ruling on OQ4 gave it two jobs: pick a group the directory has
// already produced, or name one nobody carries yet (the one thing the retired mapping form could do
// that a picker could not).
//
// The first cut stacked a Select on top of an Input, which the bounce rejected: " UI UI
// UI ". So this is ONE input with completion — the same
// shape `MemberSearchInput` gives the person picker right beside it, so both halves of "who gets this"
// read the same way. Typing filters the known names; picking one fills the field; a name that matches
// nothing is still a valid answer and says what will happen to it.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "../ui/Input";

export function GroupPicker({
  value, onChange, known, testId, ariaLabel,
}: {
  value: string;
  onChange: (name: string) => void;
  known: readonly string[];
  /** `${testId}-name` types, `${testId}-list`/`-item` complete, `${testId}-unconfirmed` is the note. */
  testId: string;
  ariaLabel: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const typed = value.trim();
  const isKnown = known.some((g) => g.toLowerCase() === typed.toLowerCase());
  // Completion, not filtering-to-death: an exact match hides the list (there is nothing left to
  // choose), and an empty field shows nothing rather than the whole directory.
  const matches = typed && !isKnown
    ? known.filter((g) => g.toLowerCase().includes(typed.toLowerCase())).slice(0, 8)
    : [];

  // The note is OUT OF FLOW and the list is anchored to the INPUT. Both were bounced for the same
  // reason: they were siblings of the input inside a flex column, so the column took their size.
  // Measured on the device — the note is wider than the field, so showing it doubled the input's width
  // (199px → 405px), grew the column, and the row's vertical centring pushed the role select and the
  // add button 11px down; the list's `top: 100%` resolved against the COLUMN, so it drifted away from
  // the field it belongs to. A hint must not move the control it is hinting about.
  const suggesting = open && matches.length > 0;
  return (
    <span className="relative flex min-w-0 flex-col">
      <span className="relative block">
        <Input
          inputSize="sm"
          value={value}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          // a blur that lands ON a suggestion must not close the list before the click registers
          onBlur={() => window.setTimeout(() => setOpen(false), 120)}
          placeholder={t("spaceMembers.groupNamePlaceholder")}
          aria-label={ariaLabel}
          data-testid={`${testId}-name`}
        />
        {suggesting && (
          <ul
            className="absolute left-0 right-0 top-[calc(100%+2px)] z-20 m-0 max-h-60 list-none overflow-y-auto rounded-md border border-border bg-panel p-1 shadow-md"
            data-testid={`${testId}-list`}
          >
            {matches.map((g) => (
              <li key={g}>
                <button
                  type="button"
                  className="w-full cursor-pointer rounded-sm border-none bg-transparent px-2 py-1.5 text-left text-sm text-foreground hover:bg-panel-2"
                  data-testid={`${testId}-item`}
                  onClick={() => { onChange(g); setOpen(false); }}
                >
                  {g}
                </button>
              </li>
            ))}
          </ul>
        )}
      </span>
      {typed !== "" && !isKnown && !suggesting && (
        // The point of the free half: a name the directory has not returned must not look identical to
        // one it has. The note says what happens next rather than implying the name is wrong — the
        // grant applies the moment somebody carrying it signs in.
        //
        // NOT while suggestions are open: half-typed "wiki" would be called unconfirmed while the list
        // is still offering "wiki Editors" to complete it. The note is about a name that is finished
        // and unmatched, so it waits until there is nothing left to choose.
        <span
          className="absolute left-0 top-[calc(100%+2px)] z-10 w-max max-w-[22rem] text-[11px] text-fg-dim"
          data-testid={`${testId}-unconfirmed`}
        >
          {t("spaceMembers.groupUnconfirmed")}
        </span>
      )}
    </span>
  );
}
