import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LANGS, setLang } from "../i18n";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "../components/ui/dropdown-menu";

// Language switcher (Phase 5). Lives in the app header next to the theme switcher;
// available to every user (members + guests) — Japanese is core to positioning, so
// the path to it must always be one click away. The choice persists (localStorage)
// and is detected from the browser on first visit (see i18n/index.ts).
export function LanguageToggle() {
  const { t, i18n } = useTranslation();
  const current = i18n.resolvedLanguage ?? i18n.language;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger className="ml-2 flex cursor-pointer rounded p-1 text-fg-dim transition-colors hover:bg-panel-2 hover:text-foreground" aria-label={t("language.label")} data-tip={t("language.label")} data-testid="language-toggle">
        <Languages size={15} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="language-menu">
        {LANGS.map((l) => (
          <DropdownMenuItem key={l} onSelect={() => setLang(l)} data-active={current === l ? "" : undefined} data-testid={`language-${l}`} className={current === l ? "font-semibold" : undefined}>
            {t(`language.${l}`)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
