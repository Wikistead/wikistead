import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuditLog, useAuditVerify, type AuditRow, type AuditVerdict } from "../data/queries";
import { useSession } from "../session/SessionProvider";
import { assetUrl } from "../data/apiClient";
import { Button } from "../ui/Button";
import { UpgradeNotice } from "../ui/UpgradeNotice";
import { disclosureKindFromError } from "../ui/upgrade-affordance";
import { notify } from "../ui/toast";

// #401 / ADR-155: the tenant-admin Audit tab — the read surface over the hash-chained compliance
// ledger. Newest-first table with keyset "load more", a Verify-chain button (verdict inline, showing
// the resolved SEQ on a break — never the raw index), and a JSONL export download. Non-entitled
// tenants see the UpgradeNotice instead of data (tab visible, data locked — ruling b); the server
// enforces both gates regardless. Actor cells show the raw sub in v1 (display-name resolution is the
// ruled follow-up d).
export function AdminAuditTab() {
  const { t } = useTranslation();
  const { token } = useSession();
  const [pages, setPages] = useState<AuditRow[][]>([]);
  const [verdict, setVerdict] = useState<AuditVerdict | null>(null);
  const firstPage = useAuditLog(null, pages.length === 0);
  const verify = useAuditVerify();

  const rows = pages.length ? pages.flat() : (firstPage.data ?? []);
  const err = firstPage.error as { code?: string; status?: number } | null;
  const locked = err?.code === "auditLog_not_entitled";

  const loadMore = async () => {
    const base = pages.length ? pages : firstPage.data ? [firstPage.data] : [];
    const last = base[base.length - 1];
    const cursor = last?.[last.length - 1]?.seq;
    if (cursor == null) return;
    try {
      const next = await (await fetch(assetUrl(`/audit?limit=50&before=${cursor}`), { headers: { authorization: `Bearer ${token}` } })).json() as AuditRow[];
      setPages([...base, next]);
    } catch {
      notify.error(t("toast.actionFailed"));
    }
  };

  const onVerify = () => verify.mutate(undefined, {
    onSuccess: setVerdict,
    onError: () => notify.error(t("toast.actionFailed")),
  });

  const onExport = async () => {
    try {
      const res = await fetch(assetUrl("/audit/export"), { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "audit-log.jsonl";
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      notify.error(t("toast.actionFailed"));
    }
  };

  if (locked) {
    return (
      <div className="max-w-[720px] p-6" data-testid="admin-audit">
        <h2 className="mt-0">{t("adminAudit.title")}</h2>
        <UpgradeNotice kind={disclosureKindFromError(err)} isAdmin testId="audit-upgrade" title={t("adminAudit.lockedTitle")} body={t("adminAudit.lockedBody")} />
      </div>
    );
  }

  return (
    <div className="max-w-[860px] p-6" data-testid="admin-audit">
      <h2 className="mt-0">{t("adminAudit.title")}</h2>
      <p className="mt-0 text-sm text-fg-dim">{t("adminAudit.body")}</p>

      <div className="mb-3 flex items-center gap-2">
        <Button variant="default" size="sm" disabled={verify.isPending} onClick={onVerify} data-testid="audit-verify">{t("adminAudit.verify")}</Button>
        <Button variant="default" size="sm" onClick={() => void onExport()} data-testid="audit-export">{t("adminAudit.export")}</Button>
        {verdict && (
          <span className={`text-sm ${verdict.valid ? "text-fg-dim" : "text-destructive"}`} data-testid="audit-verdict">
            {verdict.valid
              ? t("adminAudit.verified", { count: verdict.count })
              : t("adminAudit.broken", { seq: verdict.brokenSeq ?? "?", reason: verdict.reason ?? "" })}
          </span>
        )}
      </div>

      <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.03em] [&_th]:text-fg-dim">
        <thead>
          <tr><th>{t("adminAudit.time")}</th><th>{t("adminAudit.actor")}</th><th>{t("adminAudit.action")}</th><th>{t("adminAudit.target")}</th></tr>
        </thead>
        <tbody data-testid="audit-rows">
          {rows.map((r) => (
            <tr key={r.seq} data-testid="audit-row">
              <td className="whitespace-nowrap text-fg-dim">{new Date(r.at).toLocaleString()}</td>
              <td className="font-mono text-xs [overflow-wrap:anywhere]">{r.actor.replace(/^user:/, "")}</td>
              <td>{r.action}</td>
              <td className="font-mono text-xs [overflow-wrap:anywhere]">{r.target}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && !firstPage.isLoading && <p className="text-sm text-fg-dim">{t("adminAudit.empty")}</p>}
      {rows.length > 0 && rows.length % 50 === 0 && (
        <div className="mt-3">
          <Button variant="default" size="sm" onClick={() => void loadMore()} data-testid="audit-load-more">{t("adminAudit.loadMore")}</Button>
        </div>
      )}
    </div>
  );
}
