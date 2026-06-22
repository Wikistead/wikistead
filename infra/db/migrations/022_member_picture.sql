-- #3 user avatar. The OIDC `picture` claim (a URL to the member's profile image at
-- their IdP) is upserted on login alongside display_name. It is peer-visible identity
-- (shown on avatars / collab cursors), so it sits next to display_name — NOT email,
-- which stays admin-only. NULL = no picture → the client renders a deterministic
-- initials avatar from display_name instead.
ALTER TABLE members ADD COLUMN picture_url TEXT;
