import { useTranslation } from "react-i18next";
import { Bell, BellRing } from "lucide-react";
import { useWatchState, useToggleWatch } from "./useNotifications";

// #320 / ADR-126: the page watch toggle (🔔). Watching a page delivers a notification when it's (re)published.
// Member-only + view-gated server-side; the button is a plain round toolbar control that reflects + flips the
// per-member watch state. Rendered only for a real page the member can see.
export function WatchButton({ pageId, className }: { pageId: string; className?: string }) {
  const { t } = useTranslation();
  const state = useWatchState(pageId);
  const toggle = useToggleWatch(pageId);
  const watching = state.data?.watching ?? false;
  const label = watching ? t("watch.unwatch") : t("watch.watch");
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={watching}
      data-testid="watch-toggle"
      data-active={watching || undefined}
      disabled={toggle.isPending || state.isLoading}
      onClick={() => toggle.mutate(state.data)}
      className={className}
    >
      {watching ? <BellRing size={16} /> : <Bell size={16} />}
    </button>
  );
}
