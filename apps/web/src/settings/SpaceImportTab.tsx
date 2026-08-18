import { useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useSession } from "../session/SessionProvider";
import { useQueryClient } from "@tanstack/react-query";
import { useImportStatus, useSpacePublic } from "../data/queries";
import { importSpaceArchive, IMPORT_MAX_ARCHIVE_BYTES, type ImportDegradation, type ImportReport } from "../data/exportApi";
import { Button } from "../ui/Button";
import { SwitchRow } from "../ui/Switch";
import { useProductName } from "../app/product-name";
import { SettingsPane } from "./SettingsShell"; // #735: the pane draws the frame AND the heading

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

/**
 * Group by KIND so a reader sees "wikilink heading anchor: these 6 pages", not 6 loose rows.
 *
 * #725②: keyed on `code`, not on the English sentence. Grouping on prose would split one kind
 * into two groups the moment the server reworded it, and it is the wording that is about to become
 * the screen's own (below) — after which every row of a kind would carry the same translated heading
 * anyway. Falls back to `what` for a report from a server that predates the codes.
 */
function groupDegradations(degraded: ImportDegradation[]): { key: string; items: ImportDegradation[] }[] {
  const by = new Map<string, ImportDegradation[]>();
  for (const d of degraded) {
    const key = d.code ?? d.what;
    const list = by.get(key);
    if (list) list.push(d);
    else by.set(key, [d]);
  }
  return [...by.entries()].map(([key, items]) => ({ key, items }));
}

/**
 * The heading for a kind, and the detail under one node, in the READER'S language.
 *
 * `t()` is given the English as its default, so an unknown code degrades to what the API said rather
 * than printing a translation key at somebody (#669 fixed that exact leak once already). A detail is
 * optional: several kinds have nothing to add beyond the page's name, and inventing a sentence for
 * them would be padding.
 */
function degradationWords(d: ImportDegradation, t: TFunction): { heading: string; detail: string } {
  const heading = d.code ? String(t(`import.degraded.${d.code}`, { defaultValue: d.what })) : d.what;
  const detail = d.code
    ? String(t(`import.degradedDetail.${d.code}`, { ...(d.params ?? {}), defaultValue: d.detail ?? "" }))
    : (d.detail ?? "");
  return { heading, detail };
}

const GROUP_PREVIEW = 20;

function DegradedGroup({ items }: { items: ImportDegradation[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, GROUP_PREVIEW);
  // Every item in a group is the same kind, so the heading comes from the first one.
  const heading = degradationWords(items[0]!, t).heading;
  return (
    <div className="mt-3" data-testid="import-degraded-group">
      <h4 className="mb-1 text-sm font-semibold">{heading}</h4>
      <ul className="m-0 list-disc pl-5 text-sm">
        {shown.map((d, i) => {
          const detail = degradationWords(d, t).detail;
          return (
            <li key={`${d.node}-${i}`} data-testid="import-degraded-item">
              {d.node}
              {detail ? <span className="text-fg-dim">{` (${detail})`}</span> : null}
            </li>
          );
        })}
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

      {/* ADR-236 required this sentence because the import published nothing and the read surface then
          said the page was empty — both it and the export read the published version. #746 reversed the
          default, so the sentence follows the case that still needs it: somebody who turned publishing
          OFF is the one who will open a page and find it blank. The other branch says what happened and
          stops; a page that is visible does not need to be explained. */}
      {report.published === 0 && report.pagesCreated > 0 && (
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
          {groups.map((g) => <DegradedGroup key={g.key} items={g.items} />)}
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

      {/* #725③: this is the reader's next move after an import, and it did not look pressable.
          Measured on the real DOM: the same colour as body text, no underline, and at 17px next to a
          button — so it read as a heading. It carries the product's link colour AND an underline that
          is there before the pointer arrives, because a hover-only underline is invisible to anybody
          deciding whether there is anything to press. Sized with the lines around it, not above them. */}
      <p className="mt-5 text-sm">
        <Link to={`/spaces/${spaceId}`} className="text-[var(--link)] underline" data-testid="import-open-space">
          {t("import.openSpace")}
        </Link>
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
  // #746 (user ruling): ON. The draft default was the one behaviour that differed from every comparable
  // importer, and what it produced was a successful import whose pages read as empty. The switch stays,
  // because importing quietly for review first is a real thing to want; it is the default that moved.
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);
  const [syncReport, setSyncReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  // #746: importing now publishes by default, and in a PUBLIC space that means readable from outside
  // the moment it lands. Said as a fact next to the switch rather than as a warning — a warning that
  // appears on every import becomes furniture, and this one only appears where it is true. Fail-quiet
  // by design: if the query does not answer, nothing is claimed (the server is the fort either way).
  const spacePublic = useSpacePublic(spaceId);
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
    // #725① — the refusal that KNOWS the answer. #712put the running import's id in
    // the 409 body, and ADR-236 §5 named "show me the one that is running" as the only useful thing
    // the screen can offer here. So it does not report an error at all: it walks onto that import,
    // which is the same screen showing progress it would have shown had this upload been the one.
    if (res.kind === "busy") {
      if (res.running) {
        setSearch({ import: res.running.id }, { replace: false });
        return;
      }
      // `running: null` — the row settled between the refusal and the read. Nothing to walk onto, so
      // the honest older answer stands: something else got there first, try again.
      setError(t("import.busy"));
      return;
    }
    setError(
      res.status === 413 ? t("import.tooLarge")
        : res.status === 403 ? t("import.forbidden")
        : res.status === 400 ? t("import.invalid", { product: productName })
        : t("import.failed"),
    );
  };

  return (
    // #735 (second round): this screen landed AFTER the frame moved into the shell and wrote its own
    // anyway — `max-w-[720px] p-6` on top of the shell's own padding, and a fourth spelling of the
    // heading. It is the case the ticket is named for, arriving one week later, and the walk only
    // caught it because the space console was added to the walk in the same change.
    <SettingsPane width="list" testId="space-import-screen" title={t("import.title")} description={t("import.hint")}>

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
          {publish && spacePublic.data === true && (
            <p className="mt-1 text-sm text-fg-dim" data-testid="import-public-space-note">
              {t("import.publicSpaceNote")}
            </p>
          )}

          <p className="mt-4">
            <Button variant="primary" disabled={!file || busy} data-testid="import-start" onClick={() => void start()}>
              {t("import.start")}
            </Button>
          </p>

          {error && <p className="text-sm text-destructive" data-testid="import-error">{error}</p>}
        </div>
      )}
    </SettingsPane>
  );
}
