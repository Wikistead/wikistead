import { Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useMemberIdentity } from "../data/queries";
import { assetUrl } from "../data/apiClient";
import { Avatar } from "../ui/Avatar";

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

export function AuthorChip({ sub, name, hasAvatar: hasAvatarProp }: { sub: string; name?: string | null; hasAvatar?: boolean }) {
  const { t } = useTranslation();
  const guest = isGuestSub(sub);
  // #486 / ADR-150 Addendum 2: a VIEW-GATED surface resolves the author server-side (override ?? OIDC
  // name, i.e. also un-customized members) and passes it here. When that server value is provided we use
  // it directly and DON'T fire the client resolver — the gated response already carries the fuller name.
  const serverResolved = name !== undefined;
  // #379 / ADR-150: otherwise resolve a member sub to their CHOSEN identity (customized members only; the
  // hook no-ops for guests/anon and on guest sessions). Absent → today's formatting stays (a member with
  // no override/avatar, a deleted member, a guest surface). Display-only; authz untouched.
  const identity = useMemberIdentity(guest || serverResolved ? null : sub);
  const resolvedName = serverResolved ? (name ?? null) : (identity.data?.displayName ?? null);
  const hasAvatar = serverResolved ? hasAvatarProp === true : identity.data?.hasAvatar === true;
  const label = resolvedName ?? authorLabel(sub, t("common.guest"));
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {guest ? (
        // Guests are anonymous share-link visitors → a generic link icon, not a personal avatar.
        <span className="inline-flex h-5 w-5 flex-none items-center justify-center rounded-full bg-panel-2 text-fg-dim" data-testid="comment-avatar-guest" data-tip={t("common.guest")}>
          <Link2 size={12} aria-hidden />
        </span>
      ) : (
        // #431: the SHARED Avatar primitive (ui/avatar.ts), not a local re-implementation — so the
        // initials (1–2 chars from the label) and the colour (seeded by SUB, stable across renames)
        // match the top-right menu and every other surface for the same user.
        // The uploaded avatar keeps the ADR-150 §3 contract (the #372 mix-up class must not reappear):
        // keyed by THIS sub, src = /members/<thisSub>/avatar-image — never another sub's. A failed
        // image load falls back to the initials chip inside Avatar.
        <Avatar
          key={sub}
          name={label}
          seed={sub}
          src={hasAvatar ? assetUrl(`/members/${encodeURIComponent(sub)}/avatar-image`) : null}
          size={20}
          title={label}
          data-testid={hasAvatar ? "comment-avatar-img" : "comment-avatar"}
          className="text-[10px]"
        />
      )}
      {/* full identity stays inspectable on hover; authz is unaffected (display-only).
          max-w caps pathological labels (a 64-hex OIDC sub, a very long display name) so `truncate`
          actually engages — without a bound the span grows to its content before any clipping (#415). */}
      <span className="max-w-[18ch] truncate text-[0.8em] font-semibold text-fg-dim" data-tip={sub}>{label}</span>
    </span>
  );
}
