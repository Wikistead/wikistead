import { useTranslation } from "react-i18next";
import { usePageAnalytics } from "../data/queries";
import { AuthorChip } from "../comments/AuthorChip";
import { PageViewsChart } from "./PageViewsChart";

// #464 / ADR-175: the page analytics panel — the who-viewed roster (members named) + the guest/anonymous
// aggregate. Rendered ONLY for a page manager (the server 403s a non-manager, 404s a non-viewer), so this
// component simply reflects what the manage-gated endpoint returned. `entitled:false` → an upgrade hint,
// never the history. Members are shown via the shared AuthorChip; guests/anon stay aggregate counts —
// deliberately NOT presented as "all viewers" (the roster and the aggregate are distinct, ADR-175 §8).
export function PageAnalyticsPanel({ pageId }: { pageId: string }) {
  const { t } = useTranslation();
  const { data, isLoading } = usePageAnalytics(pageId);
  if (isLoading || !data) return null;
  if (!data.entitled) {
    return (
      <div className="mt-4 rounded-md border border-border p-3 text-sm text-fg-dim" data-testid="analytics-upsell">
        {t("pageAnalytics.upsell")}
      </div>
    );
  }

  const totals = { member: 0, guest: 0, anon: 0 };
  for (const d of data.daily) totals[d.viewerClass] += d.views;
  const members = [...new Set(data.roster.map((r) => r.memberSub))];

  return (
    <div className="mt-4 rounded-md border border-border p-3" data-testid="page-analytics">
      <h3 className="mt-0 text-sm font-semibold">{t("pageAnalytics.title")}</h3>
      {/* #464 rework slice 1: the interactive daily-views graph (member/guest/anon series, hover tooltip)
          replaces reading trends off a flat number. The totals stay as the at-a-glance sum. The right-sidebar
          placement + fullscreen (slices 2–3) move this out of the editor's bottom whitespace. */}
      <PageViewsChart daily={data.daily} />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-dim" data-testid="analytics-totals">
        <span>{t("pageAnalytics.members")}: <b className="text-foreground">{totals.member}</b></span>
        <span>{t("pageAnalytics.guests")}: <b className="text-foreground">{totals.guest}</b></span>
        <span>{t("pageAnalytics.anon")}: <b className="text-foreground">{totals.anon}</b></span>
      </div>
      {members.length > 0 && (
        <div className="mt-2">
          <div className="text-xs text-fg-dim">{t("pageAnalytics.readers")}</div>
          <div className="mt-1 flex flex-wrap gap-2" data-testid="analytics-roster">
            {members.map((sub) => <AuthorChip key={sub} sub={sub} />)}
          </div>
        </div>
      )}
    </div>
  );
}
