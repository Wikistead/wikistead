import { useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useSession } from "../session/SessionProvider";
import { useQueryClient } from "@tanstack/react-query";
import { useImportStatus } from "../data/queries";
import { importSpaceArchive, IMPORT_MAX_ARCHIVE_BYTES, type ImportDegradation, type ImportReport } from "../data/exportApi";
import { Button } from "../ui/Button";
import { SwitchRow } from "../ui/Switch";
import { useProductName } from "../app/product-name";

interface SpaceCtx { spaceId: string; name: string }

// #725 / ADR-236: the import screen. Import shipped as two routes and no surface (#308 / ADR-132), and
// the only affordance was a switcher item that flattened the fidelity report into a toast of two
// numbers — the exact failure ADR-227 exists to prevent, since the report's whole job is to NAME what
// did not survive.
//
// Three things here are decisions rather than layout:
//
//  1. **The import id lives in the URL** (`?import=<id>`). ADR-227 §7 built the job row so a report
//     OUTLIVES the connection that started it; a screen holding the id in component state throws that
//     away on the first reload. With it in the URL a reload, a closed laptop and a second tab all
//     resume on the same import.
//  2. **The 202 path is the general case.** The sync response is the same machine with the middle
//     skipped, so there is one state machine, not two screens.
//  3. **The report names things.** Degradations are grouped by what did not survive and listed by
//     node; a count is never the whole story. When a group is long the screen says how many it is
//     holding back and offers to show them, rather than truncating silently.

/** Group by `what` so a reader sees "wikilink heading anchor: these 6 pages", not 6 loose rows. */
function groupDegradations(degraded: ImportDegradation[]): { what: string; items: ImportDegradation[] }[] {
  const by = new Map<string, ImportDegradation[]>();
  for (const d of degraded) {
    const list = by.get(d.what);
    if (list) list.push(d);
    else by.set(d.what, [d]);
  }
  return [...by.entries()].map(([what, items]) => ({ what, items }));
}

const GROUP_PREVIEW = 20;

function DegradedGroup({ what, items }: { what: string; items: ImportDegradation[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, GROUP_PREVIEW);
  return (
    <div className="mt-3" data-testid="import-degraded-group">
      <h4 className="mb-1 text-sm font-semibold">{what}</h4>
      <ul className="m-0 list-disc pl-5 text-sm">
        {shown.map((d, i) => (
          <li key={`${d.node}-${i}`} data-testid="import-degraded-item">
            {d.node}
            {d.detail ? <span className="text-fg-dim">{` (${d.detail})`}</span> : null}
          </li>
        ))}
      </ul>
      {/* Never a silent truncation: the button says how many are being held back (ADR-236 §4). */}
      {!all && items.length > GROUP_PREVIEW && (
        <Button variant="ghost" size="sm" data-testid="import-degraded-showall" onClick={() => setAll(true)}>
          {t("import.showAll", { count: items.length })}
        </Button>
      )}
    </div>
  );
}

/**
 * The finished report. Exported so its rules can be pinned directly (import-report-725.test.tsx):
 * degradations by name, the draft-default sentence, and lossyTitles as a fact rather than a warning.
 */
export function ImportReportView({ report, spaceId }: { report: ImportReport; spaceId: string }) {
  const { t } = useTranslation();
  const groups = useMemo(() => groupDegradations(report.degraded ?? []), [report.degraded]);
  return (
    <div data-testid="import-report">
      <h3 className="mb-1 mt-0">{t("import.reportTitle")}</h3>
      <p className="text-sm">{t("import.pagesCreated", { count: report.pagesCreated })}</p>

      {/* The line every first-time importer needs. Measured on the running product (#712): after
          an import the read surface says the page is empty and the export comes back empty, because
          both read the PUBLISHED version and the import published nothing. A badge on a page they have
          not opened does not answer that, so it is stated in words. */}
      {report.published === 0 && (
        <p className="text-sm font-semibold" data-testid="import-draft-notice">{t("import.draftNotice")}</p>
      )}
      {report.published > 0 && (
        <p className="text-sm" data-testid="import-published-notice">{t("import.publishedNotice", { count: report.published })}</p>
      )}

      {report.attachmentsImported > 0 && (
        <p className="text-sm">{t("import.attachmentsImported", { count: report.attachmentsImported })}</p>
      )}

      {groups.length > 0 && (
        <section className="mt-4" data-testid="import-degraded">
          <h3 className="mb-0 text-base">{t("import.degradedTitle")}</h3>
          <p className="mt-1 text-sm text-fg-dim">{t("import.degradedHint")}</p>
          {groups.map((g) => <DegradedGroup key={g.what} what={g.what} items={g.items} />)}
        </section>
      )}

      {report.attachmentsSkipped.length > 0 && (
        <section className="mt-4" data-testid="import-skipped">
          <h3 className="mb-0 text-base">{t("import.skippedTitle")}</h3>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {report.attachmentsSkipped.map((a, i) => (
              <li key={`${a.name}-${i}`} data-testid="import-skipped-item">
                {a.name}
                <span className="text-fg-dim">
                  {` (${a.reason === "storage quota" ? t("import.skippedQuota") : a.reason})`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {report.deadCrossLinks > 0 && (
        <p className="mt-4 text-sm" data-testid="import-dead-links">{t("import.deadLinks", { count: report.deadCrossLinks })}</p>
      )}

      {/* Not a warning. ADR-236 was written when `lossyTitles` was `!hasManifest` and therefore true
          for every Obsidian / Notion / Confluence import; #712 has since narrowed it server-side to
          "this product's OWN export arrived without its manifest" (import/index.ts: it is cleared for
          any third-party sourceKind). Either way the treatment is the same and for the same reason —
          it says where the titles came from, and a line that is always on is a line nobody reads. */}
      {report.lossyTitles && (
        <p className="mt-4 text-sm text-fg-dim" data-testid="import-lossy-titles">{t("import.lossyTitles")}</p>
      )}

      <p className="mt-5">
        <Link to={`/spaces/${spaceId}`} data-testid="import-open-space">{t("import.openSpace")}</Link>
      </p>
    </div>
  );
}

export function SpaceImportTab() {
  const { t } = useTranslation();
  const { spaceId } = useOutletContext<SpaceCtx>();
  const { token } = useSession();
  const qc = useQueryClient();
  const productName = useProductName();
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useSearchParams();
  const importId = search.get("import");

  const [file, setFile] = useState<File | null>(null);
  const [publish, setPublish] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncReport, setSyncReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const job = useImportStatus(spaceId, importId);
  const jobRow = job.data ?? null;
  const report = syncReport ?? jobRow?.report ?? null;
  const running = !report && (busy || jobRow?.status === "queued" || jobRow?.status === "running");

  const start = async () => {
    if (!file || busy) return;
    setError(null);
    setSyncReport(null);
    // Kindness, not a gate: the same archive is validated and size-limited server-side regardless.
    if (!/\.zip$/i.test(file.name)) { setError(t("import.notZip")); return; }
    if (file.size > IMPORT_MAX_ARCHIVE_BYTES) { setError(t("import.tooLarge")); return; }
    setBusy(true);
    const res = await importSpaceArchive(token, spaceId, file, { publish });
    setBusy(false);
    if (res.kind === "report") {
      setSyncReport(res.report);
      void qc.invalidateQueries({ queryKey: ["pages", spaceId] });
      return;
    }
    if (res.kind === "queued") {
      // Straight into the URL, before anything is rendered from it (ADR-236 §3).
      setSearch({ import: res.importId }, { replace: false });
      return;
    }
    setError(
      res.status === 413 ? t("import.tooLarge")
        : res.status === 403 ? t("import.forbidden")
        // 409 is honest rather than helpful: the response carries no id, so the screen cannot offer
        // "show me the one that is running". Adding the id to that body is #712's (ADR-236 §5).
        : res.status === 409 ? t("import.busy")
        : res.status === 400 ? t("import.invalid", { product: productName })
        : t("import.failed"),
    );
  };

  return (
    <div className="max-w-[720px] p-6" data-testid="space-import-screen">
      <h2 className="mt-0">{t("import.title")}</h2>
      <p className="text-sm text-fg-dim">{t("import.hint")}</p>

      {report && (
        <>
          <ImportReportView report={report} spaceId={spaceId} />
          <p className="mt-5">
            <Button
              variant="default"
              data-testid="import-again"
              onClick={() => { setSyncReport(null); setFile(null); setSearch({}, { replace: true }); }}
            >
              {t("import.another")}
            </Button>
          </p>
        </>
      )}

      {!report && running && (
        <div data-testid="import-running">
          <p className="text-sm">
            {jobRow
              ? t("import.progress", { done: jobRow.nodesDone, total: jobRow.nodesTotal })
              : t("import.uploading")}
          </p>
          {/* The id is in the URL, so this sentence is true and the reader can act on it. */}
          {importId && <p className="text-sm text-fg-dim">{t("import.resumable")}</p>}
        </div>
      )}

      {!report && jobRow?.status === "failed" && (
        <p className="text-sm text-destructive" data-testid="import-job-failed">{t("import.failed")}</p>
      )}

      {!report && !running && (
        <div className="mt-4">
          <input
            ref={fileRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            data-testid="space-import-input"
            onChange={(e) => { const f = e.target.files?.[0] ?? null; e.currentTarget.value = ""; setFile(f); setError(null); }}
          />
          <p className="flex items-center gap-2 text-sm">
            <Button variant="default" data-testid="import-choose" onClick={() => fileRef.current?.click()}>
              {t("import.chooseFile")}
            </Button>
            <span className="text-fg-dim" data-testid="import-filename">{file ? file.name : t("import.noFile")}</span>
          </p>

          <SwitchRow
            className="mt-3"
            checked={publish}
            onChange={setPublish}
            label={t("import.publishLabel")}
            description={t("import.publishHint")}
            testId="import-publish"
          />

          <p className="mt-4">
            <Button variant="primary" disabled={!file || busy} data-testid="import-start" onClick={() => void start()}>
              {t("import.start")}
            </Button>
          </p>

          {error && <p className="text-sm text-destructive" data-testid="import-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
