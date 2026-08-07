import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Activity, Check, Filter } from "lucide-react";
import { useFeed, useTogglePatrol, type FeedItem } from "../notifications/useNotifications";
import { eventLabel } from "../notifications/feedLabels";

// #326 / ADR-142: the Recent Changes activity view — the cross-space feed of page changes, the surface the
// #320 backend served but had no web consumer for. Member-only + the server view-filters every event (an
// event about a page the member can't see never appears — the panel renders exactly the server's set). The
// "unpatrolled only" filter + the per-event patrol (reviewed) toggle are the moderation surface (C-1); the
// patrol WRITE re-checks capability server-side (view-confirm → 404 → capability), so this UI is convenience.
export function RecentChangesRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [unpatrolled, setUnpatrolled] = useState(false);
  const { data, isLoading } = useFeed({ unpatrolled });
  const togglePatrol = useTogglePatrol();
  const items = data ?? [];

  const open = (e: FeedItem) => { if (e.pageId) navigate(`/p/${e.pageId}`); };

  return (
    <div className="mx-auto max-w-[46rem] px-4 py-8 text-[length:var(--text-ui)]" data-testid="recent-changes-page">
      <Link to="/p/demo" className="mb-4 inline-flex items-center gap-1 text-fg-dim hover:text-foreground" data-testid="recent-changes-back">
        <ArrowLeft size={14} /> {t("recentChanges.back")}
      </Link>
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="flex items-center gap-2 text-[length:var(--text-lg)] font-semibold">
          <Activity size={18} /> {t("recentChanges.title")}
        </h1>
        {/* "Unpatrolled only" filter — LEFT JOIN patrolled_events server-side; the toggle re-queries. */}
        <button
          type="button"
          aria-pressed={unpatrolled}
          data-testid="recent-changes-unpatrolled"
          onClick={() => setUnpatrolled((v) => !v)}
          className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[length:var(--text-xs)] ${unpatrolled ? "border-[var(--accent)] text-[var(--accent)]" : "border-border text-fg-dim hover:bg-panel-2"}`}
        >
          <Filter size={13} /> {t("recentChanges.unpatrolledOnly")}
        </button>
      </div>
      {isLoading ? (
        <p className="text-fg-dim">{t("common.loading")}</p>
      ) : items.length === 0 ? (
        <p className="text-fg-dim" data-testid="recent-changes-empty">{t("recentChanges.empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border" data-testid="recent-changes-list">
          {items.map((e) => (
            <li key={e.id} data-testid="recent-changes-item" data-patrolled={e.patrolled || undefined} className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                onClick={() => open(e)}
                data-testid={`recent-changes-open-${e.id}`}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left hover:text-[var(--link)]"
              >
                <span className="line-clamp-2">{eventLabel(e, t)}</span>
                <time className="text-[length:var(--text-xs)] text-fg-dim" dateTime={new Date(e.createdAt).toISOString()}>
                  {new Date(e.createdAt).toLocaleString()}
                </time>
              </button>
              {/* Patrol (reviewed) toggle — POST/DELETE /feed/:id/patrol; the server re-checks capability. */}
              <button
                type="button"
                aria-pressed={e.patrolled}
                disabled={togglePatrol.isPending}
                data-testid={`recent-changes-patrol-${e.id}`}
                // #668's rule, missed here: a mark that is only an icon needs the words too. `data-tip`
                // draws a tooltip for a mouse; it is not an accessible name, so this button announced
                // itself as "button" and nothing else. Same string, so the label and the tooltip cannot
                // drift — and `aria-pressed` beside it now has something to qualify.
                aria-label={e.patrolled ? t("recentChanges.unmarkPatrolled") : t("recentChanges.markPatrolled")}
                data-tip={e.patrolled ? t("recentChanges.unmarkPatrolled") : t("recentChanges.markPatrolled")}
                onClick={() => togglePatrol.mutate({ eventId: e.id, patrolled: !!e.patrolled })}
                className={`flex-none rounded p-1 ${e.patrolled ? "text-[var(--accent)]" : "text-fg-dim hover:bg-panel-2 hover:text-foreground"}`}
              >
                <Check size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
