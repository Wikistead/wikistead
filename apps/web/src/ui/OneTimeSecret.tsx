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
// `title` carries what KIND of secret this is, because they are not interchangeable — a password entrance
// is not an invitation (#606), and a re-issued link is not a new one. `note` is where a caller says the
// thing only it knows, such as whether the mail went.
export function OneTimeSecret({ title, value, note, testId }: {
  title: string;
  value: string;
  note?: React.ReactNode;
  testId?: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      className="my-3.5 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] px-3 py-2.5"
      data-testid={testId ?? "one-time-secret"}
    >
      <p className="text-xs text-fg-dim">{title}</p>
      <div className="flex items-center gap-2">
        {/* the secret wraps rather than overflowing: these are long, and a link the reader cannot see the
            end of is one they cannot check before handing it over */}
        <code className="flex-1 font-mono text-xs [overflow-wrap:anywhere]" data-testid={testId ? `${testId}-value` : undefined}>{value}</code>
        <IconButton
          aria-label={t("adminApi.copy")}
          data-tip={t("adminApi.copy")}
          data-testid={testId ? `${testId}-copy` : "one-time-secret-copy"}
          onClick={() => { navigator.clipboard?.writeText(value); notify.success(t("toast.copied")); }}
        >
          <Copy size={14} />
        </IconButton>
      </div>
      {note && <p className="mt-1 text-xs text-fg-dim">{note}</p>}
    </div>
  );
}
