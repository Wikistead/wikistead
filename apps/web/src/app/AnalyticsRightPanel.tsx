import { useTranslation } from "react-i18next";
import { RightPanel } from "../ui/RightPanel";
import { PageAnalyticsPanel } from "./PageAnalyticsPanel";

// #464 / ADR-175 rework slice 2: page analytics as a RIGHT panel — the same shared RightPanel chrome
// (width / bg / slide-in / header / close / Esc) as comments/history, in the #206-exclusive right zone,
// instead of a static block the user couldn't find at the editor's bottom. Manager/entitled gating is
// unchanged (PageAnalyticsPanel reflects the manage-gated endpoint; the toggle is manager-only in routes).
export function AnalyticsRightPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <RightPanel testId="analytics-panel" title={t("pageAnalytics.title")} onClose={onClose}>
      <PageAnalyticsPanel pageId={pageId} />
    </RightPanel>
  );
}
