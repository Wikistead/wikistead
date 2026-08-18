import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "./Button";
import { notify } from "./toast";

// The ONE copy control. #721 asked for copy on the DNS challenge record and said, in the same
// breath, not to build a second one: the API key, SCIM and second-factor screens already share an
// idiom (icon button → clipboard → "copied" toast, labelled `adminApi.copy`), and a screen that
// copies things a different way is a screen people have to learn twice.
//
// It lives apart from `OneTimeSecret` because the box that wraps it MEANS something — "this is shown
// once, take it now" — and a DNS record is the opposite: it stays on the screen until the domain
// verifies, and there are two fields to copy separately (host and value go into different boxes in a
// DNS panel; the record TYPE is chosen from a dropdown, not pasted). OneTimeSecret now uses this too,
// so there is still one implementation of the copying itself.
export function CopyButton({ value, testId, label }: { value: string; testId?: string; label?: string }) {
  const { t } = useTranslation();
  const tip = label ?? t("adminApi.copy");
  return (
    <IconButton
      aria-label={tip}
      data-tip={tip}
      data-testid={testId}
      onClick={() => { navigator.clipboard?.writeText(value); notify.success(t("toast.copied")); }}
    >
      <Copy size={14} />
    </IconButton>
  );
}
