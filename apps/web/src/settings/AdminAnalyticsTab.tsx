import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useTenantAnalytics, type SpaceAnalyticsParams } from "../data/queries";
import { AnalyticsDashboard } from "./AnalyticsDashboard";

// #520 / ADR-189 slice 6: the TENANT analytics tab (admin console) — the other half of the approved
// "space AND tenant aggregation" scope. Server-side it is tenant#admin gated, EE gated, and built from the
// SAME §5 manage-filter-set as the space surface: even an admin's tenant-wide total covers only the pages
// they MANAGE, so a private page they do not manage never appears. The hint says exactly that, because a
// number labelled "the whole workspace" that silently omits private pages would be misleading.
export function AdminAnalyticsTab() {
  const { t } = useTranslation();
  const [params, setParams] = useState<SpaceAnalyticsParams>({});
  const { data, isLoading } = useTenantAnalytics(params);
  return (
    <AnalyticsDashboard
      testId="tenant-analytics"
      title={t("tenantAnalytics.title")}
      hint={t("tenantAnalytics.hint")}
      data={data}
      isLoading={isLoading}
      params={params}
      onParams={(patch) => setParams((p) => ({ ...p, ...patch }))}
    />
  );
}
