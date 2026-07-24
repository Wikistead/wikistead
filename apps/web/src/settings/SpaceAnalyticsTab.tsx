import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSpaceAnalytics, type SpaceAnalyticsParams } from "../data/queries";
import { PageViewsChart } from "../app/PageViewsChart";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";

// #520 / ADR-189 slice 4: the SPACE-level analytics dashboard (manager-only tab). It reflects what the
// manage-gated /spaces/:id/analytics endpoint returns — a roll-up over ONLY the pages the caller manages
// (never space#viewer), so a private page's activity never surfaces here. `entitled:false` → the upgrade
// hint, never the history. Controls (period / class filter / sort / unique) drive the same shaping params
// the server validates. The unique toggle is honestly labelled: it de-dupes MEMBERS across the space, but
// guests/anon have no cross-page session id (ADR-175 §4), so their "unique" is a session/day approximation.
export function SpaceAnalyticsTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<{ spaceId: string }>();
  const [params, setParams] = useState<SpaceAnalyticsParams>({ sort: "day", dir: "desc" });
  const { data, isLoading } = useSpaceAnalytics(spaceId, params);
  const set = (patch: Partial<SpaceAnalyticsParams>) => setParams((p) => ({ ...p, ...patch }));

  const totals = { member: 0, guest: 0, anon: 0 };
  for (const d of data?.daily ?? []) totals[d.viewerClass] += d.views;

  return (
    <div style={{ padding: 24, maxWidth: 640 }} data-testid="space-analytics">
      <h2 style={{ marginTop: 0 }}>{t("spaceAnalytics.title")}</h2>
      <p style={{ color: "var(--fg-dim)", fontSize: 13, marginTop: 0 }}>{t("spaceAnalytics.hint")}</p>

      {isLoading || !data ? (
        <div className="text-sm text-fg-dim">{t("common.loading")}</div>
      ) : !data.entitled ? (
        <div className="rounded-md border border-border p-3 text-sm text-fg-dim" data-testid="space-analytics-upsell">
          {t("pageAnalytics.upsell")}
        </div>
      ) : (
        <>
          {/* Controls: period, viewer-class filter, sort, unique. */}
          <div className="mb-4 flex flex-wrap items-end gap-3" data-testid="space-analytics-controls">
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("spaceAnalytics.from")}
              <Input inputSize="sm" type="date" value={params.from ?? ""} onChange={(e) => set({ from: e.target.value || undefined })} data-testid="space-analytics-from" aria-label={t("spaceAnalytics.from")} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("spaceAnalytics.to")}
              <Input inputSize="sm" type="date" value={params.to ?? ""} onChange={(e) => set({ to: e.target.value || undefined })} data-testid="space-analytics-to" aria-label={t("spaceAnalytics.to")} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("spaceAnalytics.viewerClass")}
              <Select size="sm" value={params.viewerClass ?? "all"} testId="space-analytics-class" ariaLabel={t("spaceAnalytics.viewerClass")}
                options={[
                  { value: "all", label: t("spaceAnalytics.all") },
                  { value: "member", label: t("pageAnalytics.members") },
                  { value: "guest", label: t("pageAnalytics.guests") },
                  { value: "anon", label: t("pageAnalytics.anon") },
                ]}
                onChange={(v) => set({ viewerClass: v === "all" ? undefined : v })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-dim">
              {t("spaceAnalytics.sort")}
              <Select size="sm" value={`${params.sort ?? "day"}:${params.dir ?? "desc"}`} testId="space-analytics-sort" ariaLabel={t("spaceAnalytics.sort")}
                options={[
                  { value: "day:desc", label: t("spaceAnalytics.sortNewest") },
                  { value: "day:asc", label: t("spaceAnalytics.sortOldest") },
                  { value: "views:desc", label: t("spaceAnalytics.sortMost") },
                  { value: "views:asc", label: t("spaceAnalytics.sortLeast") },
                ]}
                onChange={(v) => { const [sort, dir] = v.split(":"); set({ sort, dir }); }} />
            </label>
            <label className="flex items-center gap-2 text-xs text-fg-dim">
              <Switch checked={!!params.unique} onChange={(v) => set({ unique: v })} testId="space-analytics-unique" ariaLabel={t("spaceAnalytics.unique")} />
              {t("spaceAnalytics.unique")}
            </label>
          </div>

          <div className="text-xs text-fg-dim" data-testid="space-analytics-pages">{t("spaceAnalytics.pages", { n: data.pages })}</div>
          <div className="mt-2">
            <PageViewsChart daily={data.daily} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-dim" data-testid="space-analytics-totals">
            <span>{t("pageAnalytics.members")}: <b className="text-foreground">{totals.member}</b></span>
            <span>{t("pageAnalytics.guests")}: <b className="text-foreground">{totals.guest}</b></span>
            <span>{t("pageAnalytics.anon")}: <b className="text-foreground">{totals.anon}</b></span>
          </div>
          {/* Honest labelling (ADR-189 Q4): unique de-dupes MEMBERS across the space, but guests/anon are a
              session/day approximation — never presented as a distinct head-count. */}
          {params.unique && (
            <p className="mt-2 text-xs text-fg-dim" data-testid="space-analytics-unique-caveat">{t("spaceAnalytics.uniqueCaveat")}</p>
          )}
        </>
      )}
    </div>
  );
}
