import { useTranslation } from "react-i18next";

// Reuses real i18n keys — a fabricated one would trip the #662 "every t() names a key the locales
// actually have" pin for a reason that has nothing to do with this fixture.
export function Widget({ rows }: { rows: string[] }) {
  const { t } = useTranslation();
  return (
    <>
      {rows.length === 0 ? <p>{t("backlinks.empty")}</p> : <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>}
      {rows.length === 0 ? <p>{t("related.empty")}</p> : null}
    </>
  );
}
