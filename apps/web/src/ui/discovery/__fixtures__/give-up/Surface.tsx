import { useTranslation } from "react-i18next";

// A hook-shaped call the resolver has never seen and that is not imported from a queries module —
// exactly the shape #1.2's five rounds kept finding: something the checker cannot classify, sitting
// right next to a real empty-state key.
function useWidgetItems(): { items: string[] } {
  return { items: [] };
}

export function Surface() {
  const { t } = useTranslation();
  const widget = useWidgetItems();
  // Reuses a real i18n key (`backlinks.empty`) rather than a fabricated one — a fictional key would
  // trip the #662 "every t() names a key the locales actually have" pin for an unrelated reason.
  return widget.items.length === 0
    ? <p>{t("backlinks.empty")}</p>
    : <ul>{widget.items.map((item) => <li key={item}>{item}</li>)}</ul>;
}
