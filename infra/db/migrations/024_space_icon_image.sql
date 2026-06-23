-- Migration 024: space icon IMAGE upload (#6 night work). Adds an uploaded-image
-- option alongside the text glyph (023). Resolution order on the client:
--   uploaded image ▷ glyph override ▷ auto initials chip.
-- Mirrors the tenant logo (020): a server-generated storage key + the content type
-- sniffed from magic bytes. png/jpeg/webp only — SVG is excluded (the icon is served
-- as a public asset, so an SVG could carry script = stored XSS). manage-gated write,
-- public read. Lives in space_settings next to accent_key/icon; the composite FK to
-- spaces ON DELETE CASCADE cleans the row (the storage object is deleted in code).
ALTER TABLE space_settings ADD COLUMN icon_image_key TEXT;
ALTER TABLE space_settings ADD COLUMN icon_image_content_type TEXT;
