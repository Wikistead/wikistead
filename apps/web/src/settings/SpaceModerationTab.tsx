import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate } from "react-router-dom";
import { Check, Filter, ShieldAlert } from "lucide-react";
import { usePatrolQueue, useTogglePatrol, type FeedItem } from "../notifications/useNotifications";
import { eventLabel } from "../notifications/feedLabels";
import { useSpaceAbuseFilterConfig, useUpdateSpaceAbuseFilterConfig } from "../data/queries";
import { notify } from "../ui/toast";

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
          {/* #509 / ADR-187: the space's own moderation layer (additive on top of the tenant floor). */}
          <SpaceAbuseFilterSection spaceId={spaceId} />
        </>
      )}
    </div>
  );
}

// #509 / ADR-187: the per-space abuse layer editor. A space ADDS banned words (UNIONed with the tenant
// floor) and may set a STRICTER shrink ratio (max of the two) — it can never weaken the tenant floor.
// moderate-gated on the server; a leading blank field = inherit. Shows the tenant floor (read-only) and
// the effective (resolved) policy so the moderator sees exactly what applies.
function SpaceAbuseFilterSection({ spaceId }: { spaceId: string | undefined }) {
  const { t } = useTranslation();
  const { data, isLoading } = useSpaceAbuseFilterConfig(spaceId);
  const update = useUpdateSpaceAbuseFilterConfig(spaceId);
  const [ratio, setRatio] = useState("");
  const [words, setWords] = useState("");

  useEffect(() => {
    if (data) {
      setRatio(data.space.shrinkRatio != null ? String(data.space.shrinkRatio) : "");
      setWords((data.space.bannedWords ?? []).join("\n"));
    }
  }, [data]);

  const save = () => {
    const trimmedRatio = ratio.trim();
    const parsed = trimmedRatio === "" ? null : Number(trimmedRatio);
    const list = words.split("\n").map((w) => w.trim()).filter(Boolean);
    update.mutate(
      { shrinkRatio: parsed != null && Number.isFinite(parsed) ? parsed : null, bannedWords: list.length ? list : null },
      { onSuccess: () => notify.success(t("toast.saved")), onError: () => notify.error(t("toast.actionFailed")) },
    );
  };

  if (isLoading || !data) return null;
  const floor = data.tenantFloor;

  return (
    <div className="mt-8 border-t border-border pt-4" data-testid="space-abuse-filter">
      <h3 className="mt-0 text-sm font-medium">{t("spaceModeration.abuseTitle")}</h3>
      <p className="mt-0 mb-3 text-sm text-fg-dim">{t("spaceModeration.abuseBody")}</p>

      {/* the tenant floor (read-only context) — the space can only add to it */}
      <p className="mb-3 text-xs text-fg-dim" data-testid="space-abuse-floor">
        {t("spaceModeration.tenantFloor", {
          ratio: floor.shrinkRatio != null ? floor.shrinkRatio : t("spaceModeration.off"),
          count: floor.bannedWords.length,
        })}
      </p>

      <label className="block">
        <span className="block text-sm text-foreground">{t("spaceModeration.shrinkLabel")}</span>
        <span className="block text-xs text-fg-dim">{t("spaceModeration.shrinkHint")}</span>
        <input
          type="number" min="0" max="1" step="0.05" data-testid="space-abuse-shrink"
          className="mt-1 w-32 rounded-md border border-border bg-panel px-2 py-1 text-sm"
          value={ratio} onChange={(e) => setRatio(e.target.value)}
          placeholder={t("spaceModeration.inherit")} disabled={update.isPending}
        />
      </label>

      <label className="mt-4 block">
        <span className="block text-sm text-foreground">{t("spaceModeration.wordsLabel")}</span>
        <span className="block text-xs text-fg-dim">{t("spaceModeration.wordsHint")}</span>
        <textarea
          rows={5} data-testid="space-abuse-words" spellCheck={false}
          className="mt-1 w-full rounded-md border border-border bg-panel px-2 py-1 font-mono text-sm"
          value={words} onChange={(e) => setWords(e.target.value)} disabled={update.isPending}
        />
      </label>

      <p className="mt-3 text-xs text-fg-dim" data-testid="space-abuse-effective">
        {t("spaceModeration.effective", {
          ratio: data.effective.shrinkRatio != null ? data.effective.shrinkRatio : t("spaceModeration.off"),
          count: data.effective.bannedWords.length,
        })}
      </p>

      <button
        type="button" data-testid="space-abuse-save"
        className="mt-4 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50"
        onClick={save} disabled={update.isPending}
      >
        {t("common.save")}
      </button>
    </div>
  );
}
