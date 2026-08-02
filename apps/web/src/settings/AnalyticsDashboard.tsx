import { useTranslation } from "react-i18next";
import type { SpaceAnalytics, SpaceAnalyticsParams } from "../data/queries";
import { PageViewsChart } from "../app/PageViewsChart";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";

// #520 / ADR-189 slice 4/6: the page-view dashboard, shared by the SPACE tab and the TENANT (admin) tab so
// the two cannot drift. Presentation only — it renders whatever the manage-gated endpoint returned. The
// server builds every figure from the caller's §5 manage-filter-set, so a private page the caller does not
// manage never reaches this component in either scope. `entitled:false` → the upgrade hint, never history.
// #595: the totals row, as a value. In RAW mode every class is a sum of view counts. In UNIQUE mode the
// member figure is a head-count, and head-counts do not add: the daily rows are per-day distincts, so
// summing them counts a returning member once per visit. Only the server can answer the period-wide
// question (it holds the roster), so the member total defers to `memberUnique` whenever it is there.
// Guests and anon keep the sum either way — with no durable id there is nothing to de-duplicate them by,
// which is what the caveat under the numbers says.
export function analyticsTotals(data: Pick<SpaceAnalytics, "daily" | "memberUnique"> | null | undefined) {
  const totals = { member: 0, guest: 0, anon: 0 };
  for (const d of data?.daily ?? []) totals[d.viewerClass] += d.views;
  return { ...totals, member: data?.memberUnique ?? totals.member };
}

export function AnalyticsDashboard({
  title, hint, data, isLoading, params, onParams, testId,
}: {
  title: string;
  hint: string;
  data: SpaceAnalytics | null | undefined;
  isLoading: boolean;
  params: SpaceAnalyticsParams;
  onParams: (patch: Partial<SpaceAnalyticsParams>) => void;
  testId: string;
}) {
  const { t } = useTranslation();
  const totals = analyticsTotals(data);

  return (
    <div style={{ padding: 24, maxWidth: 640 }} data-testid={testId}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <p style={{ color: "var(--fg-dim)", fontSize: 13, marginTop: 0 }}>{hint}</p>

      {isLoading || !data ? (
        <div className="text-sm text-fg-dim">{t("common.loading")}</div>
      ) : !data.entitled ? (
        <div className="rounded-md border border-border p-3 text-sm text-fg-dim" data-testid={`${testId}-upsell`}>
          {t("pageAnalytics.upsell")}
        </div>
      ) : (
        <>
          {/* Controls: period, viewer-class filter, sort, unique. */}
          <div className="mb-4 flex flex-wrap items-end gap-3" data-testid={`${testId}-controls`}>
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("spaceAnalytics.from")}
              <Input inputSize="sm" type="date" value={params.from ?? ""} onChange={(e) => onParams({ from: e.target.value || undefined })} data-testid={`${testId}-from`} aria-label={t("spaceAnalytics.from")} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("spaceAnalytics.to")}
              <Input inputSize="sm" type="date" value={params.to ?? ""} onChange={(e) => onParams({ to: e.target.value || undefined })} data-testid={`${testId}-to`} aria-label={t("spaceAnalytics.to")} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("spaceAnalytics.viewerClass")}
              <Select size="sm" value={params.viewerClass ?? "all"} testId={`${testId}-class`} ariaLabel={t("spaceAnalytics.viewerClass")}
                options={[
                  { value: "all", label: t("spaceAnalytics.all") },
                  { value: "member", label: t("pageAnalytics.members") },
                  { value: "guest", label: t("pageAnalytics.guests") },
                  { value: "anon", label: t("pageAnalytics.anon") },
                ]}
                onChange={(v) => onParams({ viewerClass: v === "all" ? undefined : v })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("spaceAnalytics.sort")}
              <Select size="sm" value={`${params.sort ?? "day"}:${params.dir ?? "desc"}`} testId={`${testId}-sort`} ariaLabel={t("spaceAnalytics.sort")}
                options={[
                  { value: "day:desc", label: t("spaceAnalytics.sortNewest") },
                  { value: "day:asc", label: t("spaceAnalytics.sortOldest") },
                  { value: "views:desc", label: t("spaceAnalytics.sortMost") },
                  { value: "views:asc", label: t("spaceAnalytics.sortLeast") },
                ]}
                onChange={(v) => { const [sort, dir] = v.split(":"); onParams({ sort, dir }); }} />
            </label>
            <label className="flex items-center gap-2 text-xs text-fg-dim">
              <Switch checked={!!params.unique} onChange={(v) => onParams({ unique: v })} testId={`${testId}-unique`} ariaLabel={t("spaceAnalytics.unique")} />
              {t("spaceAnalytics.unique")}
            </label>
          </div>

          <div className="text-xs text-fg-dim" data-testid={`${testId}-pages`}>{t("spaceAnalytics.pages", { n: data.pages })}</div>
          <div className="mt-2">
            <PageViewsChart daily={data.daily} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-dim" data-testid={`${testId}-totals`}>
            <span>{t("pageAnalytics.members")}: <b className="text-foreground">{totals.member}</b></span>
            <span>{t("pageAnalytics.guests")}: <b className="text-foreground">{totals.guest}</b></span>
            <span>{t("pageAnalytics.anon")}: <b className="text-foreground">{totals.anon}</b></span>
          </div>
          {/* Honest labelling (ADR-189 Q4): unique de-dupes MEMBERS across the scope, but guests/anon are a
              session/day approximation — never presented as a distinct head-count. */}
          {params.unique && (
            <p className="mt-2 text-xs text-fg-dim" data-testid={`${testId}-unique-caveat`}>{t("spaceAnalytics.uniqueCaveat")}</p>
          )}
        </>
      )}
    </div>
  );
}
