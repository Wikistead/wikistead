import { useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSpaceAnalytics, type SpaceAnalyticsParams } from "../data/queries";
import { AnalyticsDashboard } from "./AnalyticsDashboard";

// #520 / ADR-189 slice 4: the SPACE analytics tab (manager-only). It reflects what the manage-gated
// /spaces/:id/analytics roll-up returned — pages the caller MANAGES only, never space#viewer — and renders
// it through the dashboard shared with the tenant (admin) surface.
export function SpaceAnalyticsTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<{ spaceId: string }>();
  const [params, setParams] = useState<SpaceAnalyticsParams>({});
  const { data, isLoading } = useSpaceAnalytics(spaceId, params);
  return (
    <AnalyticsDashboard
      testId="space-analytics"
      title={t("spaceAnalytics.title")}
      hint={t("spaceAnalytics.hint")}
      data={data}
      isLoading={isLoading}
      params={params}
      onParams={(patch) => setParams((p) => ({ ...p, ...patch }))}
    />
  );
}
