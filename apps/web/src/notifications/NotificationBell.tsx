import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useNavigate } from "react-router-dom";
import { Bell } from "lucide-react";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator } from "../components/ui/dropdown-menu";
import { useUnreadCount, useNotifications, useMarkNotificationRead, type FeedItem } from "./useNotifications";
import { authorLabel, isGuestSub } from "../comments/AuthorChip";

// #320 / ADR-126: the header notification bell. The badge is the raw unread count (a bare number leaks
// nothing); the popover list is the server-view-filtered inbox — a notification about a page the member can no
// longer view simply isn't in the list. Clicking an item marks it read and navigates to the page.

// The actor is an opaque string. `user:<sub>` shows the sub; a guest actor (`guest:<id>` / #331 `anon:<id>`)
// shows the short "Guest 7f3a" pseudonym via the shared authorLabel — the raw share-link id / anon hex NEVER
// reaches the screen in full (ADR-126 §2 correction 5; ADR-138 C-6 reviewer condition 3).
function actorLabel(actor: string, t: TFunction): string {
  if (actor.startsWith("user:")) return actor.slice(5);
  if (isGuestSub(actor)) return authorLabel(actor, t("notifications.guest"));
  return t("notifications.guest"); // unknown actor shape → generic, never leak
}
function eventLabel(e: FeedItem, t: TFunction): string {
  const who = actorLabel(e.actor, t);
  const title = e.title ?? t("notifications.untitled");
  switch (e.eventType) {
    case "page.published": return t("notifications.published", { who, title });
    case "page.restored": return t("notifications.restored", { who, title }); // #327 / ADR-143 C-2
    default: return t("notifications.changed", { who, title });
  }
}

export function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const unread = useUnreadCount();
  const list = useNotifications(open); // fetch the inbox only while the popover is open
  const markRead = useMarkNotificationRead();
  const count = unread.data ?? 0;

  const openItem = (e: FeedItem) => {
    if (e.notificationId && !e.read) markRead.mutate(e.notificationId);
    setOpen(false);
    if (e.pageId) navigate(`/p/${e.pageId}`);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="relative inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-dim hover:bg-panel-2 hover:text-fg"
          aria-label={t("notifications.title")}
          data-testid="notification-bell"
        >
          <Bell size={16} />
          {count > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-[var(--accent)] px-[3px] text-[10px] font-semibold leading-[15px] text-white"
              data-testid="notification-badge"
            >
              {count > 99 ? "99+" : count}
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80 max-w-[calc(100vw-1rem)]">
        <DropdownMenuLabel>{t("notifications.title")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <div className="max-h-[min(60vh,24rem)] overflow-y-auto" data-testid="notification-list">
          {list.isLoading && <div className="px-3 py-4 text-center text-sm text-fg-dim">{t("notifications.loading")}</div>}
          {!list.isLoading && (list.data?.length ?? 0) === 0 && (
            <div className="px-3 py-6 text-center text-sm text-fg-dim" data-testid="notification-empty">{t("notifications.empty")}</div>
          )}
          {list.data?.map((e) => (
            <button
              key={e.notificationId ?? e.id}
              type="button"
              onClick={() => openItem(e)}
              data-testid="notification-item"
              className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-panel-2 ${e.read ? "opacity-60" : ""}`}
            >
              <span className="line-clamp-2">{eventLabel(e, t)}</span>
              {!e.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden />}
            </button>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
