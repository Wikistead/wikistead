import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useAuditLog, useAuditVerify, type AuditRow, type AuditVerdict } from "../data/queries";
import { apiFetch } from "../data/apiClient";
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
// #503the keyset page size, and the EXPLICIT end-state derivation that replaces the
// rows.length % 50 heuristic. That heuristic failed both ways: an exact-multiple total kept the
// button alive (clicking appended an empty page and visibly did nothing), and a fractional total
// made it vanish silently with no "that's all" signal. A fetched page shorter than the limit
// (empty included) means the ledger's beginning was reached — pure and pinned in
// audit-loadmore-503.test.ts. The end notice only shows once the user has actually paged
// (pages.length > 0): a log that fits its first page needs no marker.
export const AUDIT_PAGE_LIMIT = 50;
export function auditListState<T>(firstPage: T[] | undefined, pages: T[][]): { rows: T[]; canLoadMore: boolean; showEndNotice: boolean } {
  const base = pages.length ? pages : firstPage ? [firstPage] : [];
  const rows = base.flat();
  const last = base[base.length - 1];
  const ended = last != null && last.length < AUDIT_PAGE_LIMIT;
  return { rows, canLoadMore: rows.length > 0 && !ended, showEndNotice: ended && pages.length > 0 };
}

export function AdminAuditTab() {
  const { t } = useTranslation();
  const { token } = useSession();
  const [pages, setPages] = useState<AuditRow[][]>([]);
  const [verdict, setVerdict] = useState<AuditVerdict | null>(null);
  const firstPage = useAuditLog(null, pages.length === 0);
  const verify = useAuditVerify();

  const { rows, canLoadMore, showEndNotice } = auditListState(firstPage.data, pages);
  const err = firstPage.error as { code?: string; status?: number } | null;
  const locked = err?.code === "auditLog_not_entitled";

  const loadMore = async () => {
    const base = pages.length ? pages : firstPage.data ? [firstPage.data] : [];
    const last = base[base.length - 1];
    const cursor = last?.[last.length - 1]?.seq;
    if (cursor == null) return;
    try {
      const next = await (await fetch(assetUrl(`/audit?limit=${AUDIT_PAGE_LIMIT}&before=${cursor}`), { headers: { authorization: `Bearer ${token}` } })).json() as AuditRow[];
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

      {/* #503: the ledger scrolls INSIDE a bounded box (the #463/#406 box-scroll principle) so the
          sections below it — Vendor access foremost — sit near the initial viewport instead of below
          hundreds of rows. The page keeps its own scroll; only this list scrolls. The header is sticky
          within the box, and "load more" lives at the box's scroll end so paging stays in-box. The
          initial fetch is already capped (useAuditLog limit=50, keyset paging). */}
      <div className="max-h-[26rem] overflow-y-auto rounded-md border border-border" data-testid="audit-scrollbox">
        <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:border-b [&_th]:border-border [&_th]:bg-background [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.03em] [&_th]:text-fg-dim">
          <thead>
            <tr><th>{t("adminAudit.time")}</th><th>{t("adminAudit.actor")}</th><th>{t("adminAudit.action")}</th><th>{t("adminAudit.target")}</th></tr>
          </thead>
          <tbody data-testid="audit-rows">
            {rows.map((r) => (
              <tr key={r.seq} data-testid="audit-row">
                <td className="whitespace-nowrap text-fg-dim">{new Date(r.at).toLocaleString()}</td>
                {/* raw-principal-ok: the ledger records WHO acted, and the id is the record — a hash-chained
                    entry that showed a display name would be evidence of something the name
                    could later stop meaning. Rendered as an id (mono, wrapping), not as a
                    person, which is why #578's "unknown member" label does not belong here. */}
                {/* raw-principal-ok: the ledger records WHO acted and the id IS the record (a name could later stop meaning what it meant) */}
                <td className="font-mono text-xs [overflow-wrap:anywhere]">{r.actor.replace(/^user:/, "")}</td>
                <td>{r.action}</td>
                <td className="font-mono text-xs [overflow-wrap:anywhere]">{r.target}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !firstPage.isLoading && <p className="px-2 py-2 text-sm text-fg-dim">{t("adminAudit.empty")}</p>}
        {canLoadMore && (
          <div className="px-2 py-2">
            <Button variant="default" size="sm" onClick={() => void loadMore()} data-testid="audit-load-more">{t("adminAudit.loadMore")}</Button>
          </div>
        )}
        {showEndNotice && <p className="px-2 py-2 text-sm text-fg-dim" data-testid="audit-end">{t("adminAudit.loadedAll")}</p>}
      </div>

      <VendorAccessSection />
    </div>
  );
}

// #435 / ADR-169: Access Transparency — operator break-glass disclosed to the tenant admin. The empty
// state is an EXPLICIT positive statement ("no operator access has occurred" — the feature's whole
// point). Rows show the operator's stable pseudonym, an action code, a fixed reason code and the
// timestamp — never an identity or free text. Locked plans see nothing extra here (the audit tab's
// UpgradeNotice already covers the compliance family; the server 403s regardless).
interface TransparencyRow { seq: number; at: string; actor: string; action: string; reason: string; target: string }
function VendorAccessSection() {
  const { t } = useTranslation();
  const { token } = useSession();
  const q = useQuery({
    queryKey: ["transparency"],
    queryFn: () => apiFetch<TransparencyRow[]>("/admin/transparency", token),
    staleTime: 30_000,
    retry: false,
  });
  const rows = q.data ?? [];
  if (q.error) return null; // non-entitled / non-admin: the server denied — show nothing extra
  return (
    <section className="mt-8" data-testid="vendor-access">
      <h3 className="mb-1 mt-0">{t("transparency.title")}</h3>
      <p className="mt-0 text-sm text-fg-dim">{t("transparency.body")}</p>
      {rows.length === 0 && !q.isLoading && (
        <p className="text-sm text-fg-dim" data-testid="vendor-access-empty">{t("transparency.empty")}</p>
      )}
      {rows.length > 0 && (
        <table className="w-full border-collapse text-sm [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5 [&_th]:border-b [&_th]:border-border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.03em] [&_th]:text-fg-dim">
          <thead>
            <tr><th>{t("adminAudit.time")}</th><th>{t("transparency.operator")}</th><th>{t("adminAudit.action")}</th><th>{t("transparency.reason")}</th></tr>
          </thead>
          <tbody data-testid="vendor-access-rows">
            {rows.map((r) => (
              <tr key={r.seq} data-testid="vendor-access-row">
                <td className="whitespace-nowrap text-fg-dim">{new Date(r.at).toLocaleString()}</td>
                <td className="font-mono text-xs">{r.actor}</td>
                <td>{r.action}</td>
                <td>{t(`transparency.reasons.${r.reason}`, r.reason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
