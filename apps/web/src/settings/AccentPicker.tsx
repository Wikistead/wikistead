import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { useTheme } from "../app/ThemeProvider";
import { ACCENT_PALETTE, ACCENT_PRESETS, resolvedScheme } from "../app/branding";
import styles from "./AccentPicker.module.css";

// Shared accent preset picker (Phase 5c space theme / 5d tenant branding). Swatches
// show each preset's colour for the CURRENT personal scheme (light/dark) so the
// choice previews against the user's base. The first chip clears to inherit/default.
export function AccentPicker({
  value, onChange, disabled, inheritLabel,
}: {
  value: string | null | undefined;
  onChange: (key: string | null) => void;
  disabled?: boolean;
  inheritLabel: string;
}) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const scheme = resolvedScheme(theme);
  return (
    <div className={styles.grid} role="radiogroup" aria-label={t("accent.label")}>
      <button
        type="button"
        className={`${styles.inherit} ${value == null ? styles.selected : ""}`}
        role="radio" aria-checked={value == null} disabled={disabled}
        data-testid="accent-inherit"
        onClick={() => onChange(null)}
      >
        {inheritLabel}
      </button>
      {ACCENT_PRESETS.map((key) => (
        <button
          key={key}
          type="button"
          className={`${styles.swatch} ${value === key ? styles.selected : ""}`}
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
