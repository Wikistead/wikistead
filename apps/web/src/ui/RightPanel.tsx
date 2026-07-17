import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { useEscClose } from "./useEscClose";

// #206 part 2: the shared right-sidebar shell. Comments / History / Attachments used to each carry
// their OWN chrome — and had drifted (320px + bg-panel vs 300px + no bg). This is the SINGLE source
// of that chrome: width, background, border, slide-in, padding, the header (title + optional actions
// + close) and Esc-to-close. A panel supplies only its title/actions/body — change the look here and
// all three follow. Exclusivity (one panel open at a time) stays in routes.tsx (part 1).
// #406 S1 (ADR-159 §3): below md the panel is a FULL-WIDTH overlay sheet (fixed under the header,
// covering the content) — the docked 320px aside only exists at md+. Exclusivity (one occupant,
// routes.tsx) and every close affordance (X, Esc) are shared by both renderings.
const SHELL =
  "wks-slide-right flex min-h-0 flex-col gap-3 overflow-y-auto border-border bg-panel p-3 " +
  "fixed inset-x-0 bottom-0 top-[var(--header-h)] z-40 w-full border-t " +
  "md:static md:inset-auto md:bottom-auto md:top-auto md:z-auto md:w-[320px] md:flex-none md:border-l md:border-t-0";
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
