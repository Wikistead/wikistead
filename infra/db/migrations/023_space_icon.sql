-- #4 space icon. An OPTIONAL override glyph (an emoji or short label) for a space.
-- NULL = auto: the client renders a deterministic initials chip from the space name
-- (same primitive as the #3 user avatar), so every space has a visual with no input.
-- Lives in space_settings next to accent_key (the per-space branding row). Unlike the
-- accent it is NOT entitlement-gated — a space icon is basic UX, not a Pro lever.
ALTER TABLE space_settings ADD COLUMN icon TEXT;
