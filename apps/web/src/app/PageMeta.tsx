import { useTranslation } from "react-i18next";
import { AuthorChip } from "../comments/AuthorChip";

// #222 (comment 824, option A): the small metadata row under the page title — who CREATED the page, who
// last PUBLISHED it, and when. Subs resolve to name/avatar via the shared AuthorChip (a deleted member
// still reads from its sub — no crash, no layout break). Muted + small so it stays subordinate to the
// title; wraps (flex-wrap) instead of overflowing when the title clamps to two lines. Shown only to page
// viewers (the whole page is 404 to non-viewers), so it leaks nothing. Renders nothing until any field
// exists (pre-migration pages, or a never-published draft with no updater).
function relTime(iso: string, lang: string): { rel: string; abs: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { rel: iso, abs: iso };
  const abs = d.toLocaleString();
  const secs = Math.round((d.getTime() - Date.now()) / 1000); // negative = past
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const table: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, s] of table) if (Math.abs(secs) >= s) return { rel: rtf.format(Math.round(secs / s), unit), abs };
  return { rel: rtf.format(secs, "second"), abs };
}

export function PageMeta({ createdBy, updatedBy, updatedAt }: { createdBy?: string | null; updatedBy?: string | null; updatedAt?: string }) {
  const { t, i18n } = useTranslation();
  if (!createdBy && !updatedBy && !updatedAt) return null;
  const time = updatedAt ? relTime(updatedAt, i18n.language) : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.72rem] text-fg-dim" data-testid="page-meta">
      {createdBy && (
        <span className="flex items-center gap-1">{t("pageMeta.created")}<AuthorChip sub={createdBy} /></span>
      )}
      {updatedBy && (
        <span className="flex items-center gap-1">{t("pageMeta.updated")}<AuthorChip sub={updatedBy} /></span>
      )}
      {time && (
        <time dateTime={updatedAt} title={time.abs} data-testid="page-meta-time">{time.rel}</time>
      )}
    </div>
  );
}
