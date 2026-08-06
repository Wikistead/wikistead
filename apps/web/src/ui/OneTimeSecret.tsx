import type React from "react";
import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./Button";
import { notify } from "./toast";

// #638 (user ruling/): the one way this product hands somebody a secret it will never show
// again.
//
// Three of them existed on two screens and only one was usable. A new API key came in a bordered box that
// said "copy this now" and had a copy button; the invite link and the password-setup link were sentences
// of `<code>` with neither — seventy characters to select by hand, no word about the one chance, and in
// the password case rendered under the invite FORM while the button that produced it was a row menu two
//
// So the box moves here and all three take it. The ruling is explicit that a third spelling must not
// appear, and the two that were bare are the ones that strand people: an API key can be re-issued from
// its own row, while a lost invite link used to mean revoking and inviting again.
//
// #638the sentence lives HERE, not in each caller. Sharing the box while every caller passed its
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
        {/* #653④: a key meant to be TYPED, in groups of four and a size a person can read off a
          screen while holding a phone. `grouped` is display only — `data-testid`'s text is the raw
          value, so a test (and a copy) still gets exactly what the server sent. */}
      <code
        className={`flex-1 font-mono [overflow-wrap:anywhere] ${grouped ? "text-sm tracking-wider" : "text-xs"}`}
        data-testid={testId ? `${testId}-value` : undefined}
      >{grouped ? value.replace(/(.{4})/g, "$1 ").trim() : value}</code>
        <IconButton
          aria-label={t("adminApi.copy")}
          data-tip={t("adminApi.copy")}
          data-testid={testId ? `${testId}-copy` : "one-time-secret-copy"}
          onClick={() => { navigator.clipboard?.writeText(value); notify.success(t("toast.copied")); }}
        >
          <Copy size={14} />
        </IconButton>
      </div>
      {/* #646: named, so the two doors' bodies can be compared. They could not be before, and the
          title-only pin stayed green while the same secret said different things by door. */}
      {note && <p className="mt-1 text-xs text-fg-dim" data-testid={testId ? `${testId}-note` : undefined}>{note}</p>}
    </div>
  );
}
