import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useEscClose } from "./useEscClose";

// #206 part 2: the shared right-sidebar shell. Comments / History / Attachments used to each carry
// their OWN chrome — and had drifted (320px + bg-panel vs 300px + no bg). This is the SINGLE source
// of that chrome: width, background, border, slide-in, padding, the header (title + optional actions
// + close) and Esc-to-close. A panel supplies only its title/actions/body — change the look here and
// all three follow. Exclusivity (one panel open at a time) stays in routes.tsx (part 1).
const SHELL =
  "wks-slide-right flex min-h-0 w-[320px] flex-none flex-col gap-3 overflow-y-auto border-l border-border bg-panel p-3";
const CLOSE_BTN =
  "inline-flex flex-none items-center justify-center rounded-md p-1 text-fg-dim hover:bg-panel-2 hover:text-foreground";

export function RightPanel({
  testId, title, onClose, headerActions, children,
}: {
  testId: string; // e.g. "comments-panel" — the close button derives "<name>-close"
  title: ReactNode;
  onClose: () => void;
  headerActions?: ReactNode; // controls shown to the LEFT of the close button (e.g. the comments tabs)
  children: ReactNode;
}) {
  const { t } = useTranslation();
  useEscClose(onClose);
  const closeTestId = `${testId.replace(/-panel$/, "")}-close`;
  return (
    <aside className={SHELL} data-testid={testId}>
      <header className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[14px] font-semibold">{title}</span>
        <div className="inline-flex flex-none items-center gap-2">
          {headerActions}
          <button type="button" className={CLOSE_BTN} data-testid={closeTestId} aria-label={t("common.close")} onClick={onClose}>
            <X size={16} aria-hidden />
          </button>
        </div>
      </header>
      {children}
    </aside>
  );
}
