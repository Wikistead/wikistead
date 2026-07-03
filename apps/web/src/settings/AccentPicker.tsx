import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useTheme } from "../app/ThemeProvider";
import { ACCENT_PALETTE, ACCENT_PRESETS, resolvedScheme } from "../app/branding";
import { cn } from "../lib/utils";

// Shared accent preset picker (Phase 5c space theme / 5d tenant branding). Swatches
// show each preset's colour for the CURRENT personal scheme (light/dark) so the
// choice previews against the user's base. The first chip clears to inherit/default.
export function AccentPicker({
  value, onChange, disabled, inheritLabel, allowInherit = true,
}: {
  value: string | null | undefined;
  onChange: (key: string | null) => void;
  disabled?: boolean;
  inheritLabel: string;
  // #201: whether to offer the "inherit / default" chip. TENANT branding sets this false — the tenant
  // is the top of the cascade, so it always picks a concrete colour (no inherit). USER settings keep it
  // (null = inherit the tenant accent).
  allowInherit?: boolean;
}) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const scheme = resolvedScheme(theme);
  return (
    <div className="flex flex-wrap items-center gap-2.5" role="radiogroup" aria-label={t("accent.label")}>
      {allowInherit && (
      <button
        type="button"
        className={cn(
          "h-8 cursor-pointer rounded-2xl border border-border bg-panel px-3 text-xs text-foreground hover:bg-panel-2 disabled:cursor-not-allowed disabled:opacity-50",
          value == null && "border-[var(--fg)] font-semibold",
        )}
        role="radio" aria-checked={value == null} disabled={disabled}
        data-testid="accent-inherit"
        onClick={() => onChange(null)}
      >
        {inheritLabel}
      </button>
      )}
      {ACCENT_PRESETS.map((key) => (
        <button
          key={key}
          type="button"
          className={cn(
            "flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 border-transparent p-0 shadow-[0_0_0_1px_var(--border)] disabled:cursor-not-allowed disabled:opacity-50",
            value === key && "border-[var(--fg)] shadow-[0_0_0_2px_var(--bg),0_0_0_4px_var(--fg)]",
          )}
          role="radio" aria-checked={value === key} disabled={disabled}
          aria-label={t(`accent.${key}`)}
          title={t(`accent.${key}`)}
          data-testid={`accent-${key}`}
          style={{ background: ACCENT_PALETTE[key]![scheme].accent }}
          onClick={() => onChange(key)}
        >
          {value === key && <Check size={14} color={ACCENT_PALETTE[key]![scheme].fg} />}
        </button>
      ))}
    </div>
  );
}
