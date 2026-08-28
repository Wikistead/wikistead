import { useTranslation } from "react-i18next";

// The `related.empty` surface from the `full` fixture has been deleted — §3.4's floor must drop to
// match, not stay pinned at a number typed once.
export function Widget({ rows }: { rows: string[] }) {
  const { t } = useTranslation();
  return rows.length === 0 ? <p>{t("backlinks.empty")}</p> : <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>;
}
