import { useState } from "react";
import { ListBox } from "../ui/list-rows";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Eye, BellOff, Bell, X, SlidersHorizontal } from "lucide-react";
import { useWatchList, useUpdateWatch, useUnwatch, WATCH_EVENT_TYPES, type WatchRow } from "./useNotifications";

// #362 the watch-management list — reached from the notification bell ("the bell is the watch
// entry point"). Rows come from GET /watches: the server resolves titles VIEW-FILTERED (a target the
// member can no longer view arrives title:null and renders as an inert untitled row — never a title
// oracle; unwatch stays available so the stale row can be cleaned up). Mute and the per-watch event
// mask are member-scoped emission filters (PATCH /watches/:id); display authz is untouched.

const SCOPE_LABEL: Record<WatchRow["resourceType"], string> = {
  page: "watches.scopePage",
  subtree: "watches.scopeSubtree",
  space: "watches.scopeSpace",
};

function MaskEditor({ row }: { row: WatchRow }) {
  const { t } = useTranslation();
  const update = useUpdateWatch();
  const mask = row.eventMask;
  const all = mask.length === 0;
  const toggleType = (type: string) => {
    // Empty mask = ALL types. Unchecking one from "all" materialises the full set minus it; a mask that
    // grows back to every type collapses to [] (all) so the permissive default stays representable.
    const current = all ? [...WATCH_EVENT_TYPES] : mask;
    const next = current.includes(type) ? current.filter((x) => x !== type) : [...current, type];
    update.mutate({ id: row.id, eventMask: next.length === WATCH_EVENT_TYPES.length ? [] : next });
  };
  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1" data-testid="watch-mask-editor">
      {WATCH_EVENT_TYPES.map((type) => (
        <label key={type} className="inline-flex cursor-pointer items-center gap-1 text-[length:var(--text-xs)] text-fg-dim">
          <input
            type="checkbox"
            checked={all || mask.includes(type)}
            disabled={update.isPending}
            onChange={() => toggleType(type)}
            data-testid={`watch-mask-${type}`}
          />
          {t(`eventTypes.${type}`)}
        </label>
      ))}
    </div>
  );
}

export function WatchListRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data, isLoading } = useWatchList();
  const update = useUpdateWatch();
  const unwatch = useUnwatch();
  const [editing, setEditing] = useState<string | null>(null); // row id whose mask editor is open
  const rows = data ?? [];

  return (
    <div className="mx-auto max-w-[46rem] px-4 py-8 text-[length:var(--text-ui)]" data-testid="watch-list-page">
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-fg-dim hover:text-foreground" data-testid="watch-list-back">
        <ArrowLeft size={14} /> {t("recentChanges.back")}
      </Link>
      <h1 className="mb-4 flex items-center gap-2 text-[length:var(--text-lg)] font-semibold">
        <Eye size={18} /> {t("watches.title")}
      </h1>
      {isLoading && <div className="py-8 text-center text-fg-dim">{t("notifications.loading")}</div>}
      {!isLoading && rows.length === 0 && (
        <div className="py-10 text-center text-fg-dim" data-testid="watch-list-empty">{t("watches.empty")}</div>
      )}
      <ListBox>
          {/* #623 slice 10: the shared box from #639 — the same 26rem everywhere, so a long list
              scrolls inside itself instead of growing the page. The server bound landed in slice 4; the
              container waited until #639 settled, so this did not become a second one. */}
        <ul className="divide-y divide-border" data-testid="watch-list">
          {rows.map((w) => (
            <li key={w.id} className={`py-2 ${w.muted ? "opacity-60" : ""}`} data-testid="watch-row">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  {w.title && w.resourceType !== "space" ? (
                    <button type="button" onClick={() => navigate(`/p/${w.resourceId}`)} className="block max-w-full truncate text-left text-[var(--link)] hover:underline" data-testid="watch-row-title">
                      {w.title}
                    </button>
                  ) : (
                    // A space row (no page route to open) or a view-filtered target (title null → inert).
                    <span className={`block truncate ${w.title ? "" : "italic text-fg-dim"}`} data-testid="watch-row-title">
                      {w.title ?? t("watches.untitled")}
                    </span>
                  )}
                  <span className="text-[length:var(--text-xs)] text-fg-dim">{t(SCOPE_LABEL[w.resourceType])}{w.muted ? ` · ${t("watches.muted")}` : ""}</span>
                </div>
                <button
                  type="button"
                  data-tip={t("watches.maskEdit")}
                  aria-label={t("watches.maskEdit")}
                  onClick={() => setEditing((cur) => (cur === w.id ? null : w.id))}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-dim hover:bg-panel-2 hover:text-foreground"
                  data-testid="watch-mask-toggle"
                >
                  <SlidersHorizontal size={14} />
                </button>
                <button
                  type="button"
                  data-tip={w.muted ? t("watches.unmute") : t("watches.mute")}
                  aria-label={w.muted ? t("watches.unmute") : t("watches.mute")}
                  aria-pressed={w.muted}
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: w.id, muted: !w.muted })}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-dim hover:bg-panel-2 hover:text-foreground"
                  data-testid="watch-mute-toggle"
                >
                  {w.muted ? <BellOff size={14} /> : <Bell size={14} />}
                </button>
                <button
                  type="button"
                  data-tip={t("watch.unwatch")}
                  aria-label={t("watch.unwatch")}
                  disabled={unwatch.isPending}
                  onClick={() => unwatch.mutate(w.id)}
                  // #504: red at rest (the policy forbids hover-only red); no confirm — re-watching is
                  // one click on the page (exception candidate)
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md text-destructive hover:bg-[color-mix(in_srgb,var(--danger)_12%,transparent)]"
                  data-testid="watch-unwatch"
                >
                  <X size={14} />
                </button>
              </div>
              {editing === w.id && <MaskEditor row={w} />}
            </li>
          ))}
        </ul>
      </ListBox>
    </div>
  );
}
