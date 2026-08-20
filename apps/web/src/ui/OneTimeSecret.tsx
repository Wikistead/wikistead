import type React from "react";
import { useTranslation } from "react-i18next";
import { CopyButton } from "./CopyButton";

// #638 (user ruling/): the one way this product hands somebody a secret it will never show
// again.
//
// Three of them existed on two screens and only one was usable. A new API key came in a bordered box that
// said "copy this now" and had a copy button; the invite link and the password-setup link were sentences
// of `<code>` with neither — seventy characters to select by hand, no word about the one chance, and in
// the password case rendered under the invite FORM while the button that produced it was a row menu two
// screens up (the place it appears is very hard to find).
//
// So the box moves here and all three take it. The ruling is explicit that a third spelling must not
// appear, and the two that were bare are the ones that strand people: an API key can be re-issued from
// its own row, while a lost invite link used to mean revoking and inviting again.
//
// #638 the sentence lives HERE, not in each caller. Sharing the box while every caller passed its
// own wording left two different Japanese sentences saying the same thing in the same box — one of them
// badly — which is half the point of a shared component thrown away. WHAT kind of secret this is belongs
// to the dialog's title above it (a password entrance is not an invitation, #606); how long the reader
// has to copy it is the same fact everywhere, so it is said the same way everywhere.
// `note` remains for what only a caller knows, such as whether the mail went.
export function OneTimeSecret({ value, note, testId, grouped }: {
  value: string;
  note?: React.ReactNode;
  testId?: string;
  /** display the value in groups of four, larger — for a secret meant to be typed rather than pasted */
  grouped?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="my-3.5 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] px-3 py-2.5"
      data-testid={testId ?? "one-time-secret"}
    >
      <p className="text-xs text-fg-dim">{t("common.copyOnce")}</p>
      <div className="flex items-center gap-2">
        {/* the secret wraps rather than overflowing: these are long, and a link the reader cannot see the
            end of is one they cannot check before handing it over */}
        {/* #653 ④: a key meant to be TYPED, in groups of four and a size a person can read off a
          screen while holding a phone. `grouped` is display only — `data-testid`'s text is the raw
          value, so a test (and a copy) still gets exactly what the server sent. */}
        {/* #650: `whitespace-pre-wrap` because a secret may be a SET — the ten recovery codes arrive as
            ten lines, and HTML's default collapses every one of them into a single run-on string.
            Measured, and it is invisible to a test that reads the value it passed IN rather than the
            text the browser laid out. A no-op for the single-line secrets above: they contain no
            newlines, and the wrapping is unchanged. */}
      <code
        className={`flex-1 whitespace-pre-wrap font-mono [overflow-wrap:anywhere] ${grouped ? "text-sm tracking-wider" : "text-xs"}`}
        data-testid={testId ? `${testId}-value` : undefined}
      >{grouped ? value.replace(/(.{4})/g, "$1 ").trim() : value}</code>
        {/* #721 the copying itself moved to CopyButton so the DNS record could reuse it
            without a second spelling. The box, the "shown once" sentence and the note stay here —
            they are what makes this a ONE-TIME secret rather than a value with a copy button. */}
        <CopyButton value={value} testId={testId ? `${testId}-copy` : "one-time-secret-copy"} />
      </div>
      {/* #646: named, so the two doors' bodies can be compared. They could not be before, and the
          title-only pin stayed green while the same secret said different things by door. */}
      {note && <p className="mt-1 text-xs text-fg-dim" data-testid={testId ? `${testId}-note` : undefined}>{note}</p>}
    </div>
  );
}
