import { useTranslation } from "react-i18next";
import { AuthorChip } from "../comments/AuthorChip";
import { relTime } from "../ui/relative-time";

// #222 (comment 824, option A): the small metadata row under the page title — who CREATED the page, who
// last PUBLISHED it, and when. Subs resolve to name/avatar via the shared AuthorChip (a deleted member
// still reads from its sub — no crash, no layout break). Muted + small so it stays subordinate to the
// title; wraps (flex-wrap) instead of overflowing when the title clamps to two lines. Shown only to page
// viewers (the whole page is 404 to non-viewers), so it leaks nothing. Renders nothing until any field
// exists (pre-migration pages, or a never-published draft with no updater).
export function PageMeta({ createdBy, updatedBy, updatedAt, createdByName, createdByHasAvatar, updatedByName, updatedByHasAvatar }: { createdBy?: string | null; updatedBy?: string | null; updatedAt?: string; createdByName?: string | null; createdByHasAvatar?: boolean; updatedByName?: string | null; updatedByHasAvatar?: boolean }) {
  const { t, i18n } = useTranslation();
  if (!createdBy && !updatedBy && !updatedAt) return null;
  const time = updatedAt ? relTime(updatedAt, i18n.language) : null;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.72rem] text-fg-dim" data-testid="page-meta">
      {/* min-w-0 lets the flex chain shrink these below their content width, so the AuthorChip
          label's truncate takes effect instead of the byline overflowing the title column (#415).
          #486: the server resolved the author name on this view-gated response — pass it so a member
          who never customized still shows their IdP name (no extra /members/identities round-trip). */}
      {createdBy && (
        <span className="flex min-w-0 items-center gap-1">{t("pageMeta.created")}<AuthorChip sub={createdBy} name={createdByName} hasAvatar={createdByHasAvatar} /></span>
      )}
      {updatedBy && (
        <span className="flex min-w-0 items-center gap-1">{t("pageMeta.updated")}<AuthorChip sub={updatedBy} name={updatedByName} hasAvatar={updatedByHasAvatar} /></span>
      )}
      {time && (
        <time dateTime={updatedAt} title={time.abs} data-testid="page-meta-time">{time.rel}</time>
      )}
    </div>
  );
}
