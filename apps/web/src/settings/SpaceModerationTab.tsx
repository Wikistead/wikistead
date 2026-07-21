import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate } from "react-router-dom";
import { Check, Filter, ShieldAlert } from "lucide-react";
import { usePatrolQueue, useTogglePatrol, type FeedItem } from "../notifications/useNotifications";
import { eventLabel } from "../notifications/feedLabels";

// #326 / ADR-142 Addendum 2: the space MODERATION tab — the patrol queue for the people who manage
// this space. It shows the supply the 2026-07-14 ruling named: refusals at the abuse boundaries
// (a publish rejected, a guest rate-capped) and anonymous / share-link activity. Ordinary member
// edits are not in it — those are activity, and activity is what the feed is for.
//
// Everything here is convenience. The server gates the listing on space#moderate and confirms view on
// every event before returning it, and the patrol write re-checks capability in its own order
// (view-confirm → uniform 404 → capability 403). A 403 is rendered as a denial rather than an empty
// list, because "nothing to review" and "you may not review this" must never look the same.
export function SpaceModerationTab() {
  const { t } = useTranslation();
  const { spaceId } = useParams<{ spaceId: string }>();
  const navigate = useNavigate();
  const [unpatrolled, setUnpatrolled] = useState(true); // the queue's job is what still needs review
  const { data, isLoading, error } = usePatrolQueue(spaceId, { unpatrolled });
  const togglePatrol = useTogglePatrol();
  const items = data ?? [];
  const denied = (error as { status?: number } | null)?.status === 403;

  return (
    <div className="max-w-[860px] p-6" data-testid="space-moderation">
      <h2 className="mt-0 flex items-center gap-2"><ShieldAlert size={18} /> {t("moderation.title")}</h2>
      <p className="mt-0 mb-4 text-sm text-fg-dim">{t("moderation.body")}</p>

      {denied ? (
        <p className="text-sm text-fg-dim" data-testid="moderation-denied">{t("moderation.denied")}</p>
      ) : (
        <>
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              aria-pressed={unpatrolled}
              data-testid="moderation-unpatrolled"
              onClick={() => setUnpatrolled((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${unpatrolled ? "border-[var(--accent)] text-[var(--accent)]" : "border-border text-fg-dim hover:bg-panel-2"}`}
            >
              <Filter size={13} /> {t("moderation.unreviewedOnly")}
            </button>
          </div>
          {isLoading ? (
            <p className="text-fg-dim">{t("common.loading")}</p>
          ) : items.length === 0 ? (
            <p className="text-sm text-fg-dim" data-testid="moderation-empty">
              {unpatrolled ? t("moderation.emptyUnreviewed") : t("moderation.empty")}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border" data-testid="moderation-list">
              {items.map((e: FeedItem) => (
                <li key={e.id} data-testid="moderation-item" data-patrolled={e.patrolled || undefined} className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => { if (e.pageId) navigate(`/p/${e.pageId}`); }}
                    disabled={!e.pageId}
                    data-testid={`moderation-open-${e.id}`}
                    className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left hover:text-[var(--link)] disabled:cursor-default disabled:hover:text-inherit"
                  >
                    <span className="line-clamp-2 text-sm">{eventLabel(e, t)}</span>
                    <time className="text-xs text-fg-dim" dateTime={new Date(e.createdAt).toISOString()}>
                      {new Date(e.createdAt).toLocaleString()}
                    </time>
                  </button>
                  <button
                    type="button"
                    aria-pressed={e.patrolled}
                    disabled={togglePatrol.isPending}
                    data-testid={`moderation-patrol-${e.id}`}
                    title={e.patrolled ? t("recentChanges.unmarkPatrolled") : t("recentChanges.markPatrolled")}
                    onClick={() => togglePatrol.mutate({ eventId: e.id, patrolled: !!e.patrolled })}
                    className={`flex-none rounded p-1 ${e.patrolled ? "text-[var(--accent)]" : "text-fg-dim hover:bg-panel-2 hover:text-foreground"}`}
                  >
                    <Check size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
