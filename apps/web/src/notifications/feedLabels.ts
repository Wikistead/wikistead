import type { TFunction } from "i18next";
import { authorLabel, isGuestSub } from "../comments/AuthorChip";
import type { FeedItem } from "./useNotifications";

// #320 / ADR-126 · #326: shared feed-item labelling used by BOTH the header NotificationBell (personal inbox)
// and the Recent Changes activity view (#326). The actor is an opaque string; a guest/anon actor renders the
// short "Guest 7f3a" pseudonym via the shared authorLabel — the raw share-link id / anon hex NEVER reaches the
// screen in full (ADR-126 §2 correction 5; ADR-138 C-6 reviewer condition 3).
export function actorLabel(actor: string, t: TFunction): string {
  if (actor.startsWith("user:")) return actor.slice(5);
  if (isGuestSub(actor)) return authorLabel(actor, t("notifications.guest"));
  return t("notifications.guest"); // unknown actor shape → generic, never leak
}

export function eventLabel(e: FeedItem, t: TFunction): string {
  const who = actorLabel(e.actor, t);
  const title = e.title ?? t("notifications.untitled");
  switch (e.eventType) {
    case "page.published": return t("notifications.published", { who, title });
    case "page.restored": return t("notifications.restored", { who, title }); // #327 / ADR-143 C-2
    // #326: a refusal is not a change. Falling through to "changed" would tell a moderator that a
    // publish they are looking at went through — the opposite of what happened.
    case "abuse.publish_rejected_mass_delete": return t("notifications.abuseMassDelete", { who, title });
    case "abuse.publish_rejected_banned": return t("notifications.abuseBanned", { who, title });
    case "abuse.rate_capped_publish": return t("notifications.abuseRatePublish", { who, title });
    case "abuse.rate_capped_create": return t("notifications.abuseRateCreate", { who });
    default: return t("notifications.changed", { who, title });
  }
}
