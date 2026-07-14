import { Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMemberIdentity } from "../data/queries";
import { assetUrl } from "../data/apiClient";

// #208: the comment author display. The stored identity is the raw `authorSub` (a member OIDC sub or
// `guest:<uuid>`) — used for authz server-side and NEVER changed here; this only formats how it READS.
// Guests showed a full UUID ("guest:3ca39b02-…") which is unreadable → shorten to "Guest <4 chars>"
// (stable per guest). Members show a friendly label (email local-part when the sub is an email).

// A guest identity is `guest:<uuid>` (the share-link id) OR, since #331 / ADR-138 (C-6), `anon:<12 hex>` (the
// pseudonymous per-session id the server records as the revision/feed actor). Both are 6-char prefixes, so the
// short label ("Guest 7f3a") is the first 4 chars after the prefix either way. NEVER shown raw.
const GUEST_PREFIXES = ["guest:", "anon:"];
export function isGuestSub(sub: string): boolean {
  return GUEST_PREFIXES.some((p) => sub.startsWith(p));
}

// Human-readable author label. Guest → "Guest 3ca3" / "Guest 7f3a" (short, stable). Member → email local-part,
// or the sub verbatim when it isn't an email. `guestWord` is the localized "Guest".
export function authorLabel(sub: string, guestWord: string): string {
  for (const p of GUEST_PREFIXES) {
    if (sub.startsWith(p)) return `${guestWord} ${sub.slice(p.length, p.length + 4)}`;
  }
  const at = sub.indexOf("@");
  return at > 0 ? sub.slice(0, at) : sub;
}

// Deterministic hue so the same member always gets the same avatar colour.
function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function AuthorChip({ sub }: { sub: string }) {
  const { t } = useTranslation();
  const guest = isGuestSub(sub);
  // #379 / ADR-150: resolve a member sub to their CHOSEN identity (customized members only; the hook
  // no-ops for guests/anon and on guest sessions). Absent → today's formatting stays (a member with no
  // override/avatar, a deleted member, a guest surface). Display-only; authz untouched.
  const identity = useMemberIdentity(guest ? null : sub);
  const resolvedName = identity.data?.displayName ?? null;
  const hasAvatar = identity.data?.hasAvatar === true;
  const label = resolvedName ?? authorLabel(sub, t("common.guest"));
  const initial = (label.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {guest ? (
        // Guests are anonymous share-link visitors → a generic link icon, not a personal avatar.
        <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-panel-2 text-fg-dim" data-testid="comment-avatar-guest" title={t("common.guest")}>
          <Link2 size={12} aria-hidden />
        </span>
      ) : hasAvatar ? (
        // The uploaded avatar. ADR-150 §3 contract (the #372 mix-up class must not reappear here):
        // keyed by THIS sub, and the src is /members/<thisSub>/avatar-image — never another sub's.
        <img
          key={sub}
          src={assetUrl(`/members/${encodeURIComponent(sub)}/avatar-image`)}
          alt=""
          className="h-5 w-5 flex-none rounded-full object-cover"
          data-testid="comment-avatar-img"
          referrerPolicy="no-referrer"
        />
      ) : (
        <span
          className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{ backgroundColor: `hsl(${hue(sub)} 55% 45%)` }}
          data-testid="comment-avatar"
          aria-hidden
        >
          {initial}
        </span>
      )}
      {/* full identity stays inspectable on hover; authz is unaffected (display-only). */}
      <span className="truncate text-[0.8em] font-semibold text-fg-dim" title={sub}>{label}</span>
    </span>
  );
}
