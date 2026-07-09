-- Migration 059: server-sniffed inline classification for attachments (#273 / ADR-120).
--
-- inline_kind is derived at confirm time by magic-byte sniffing the uploaded object's
-- leading bytes — NEVER from the client-declared content_type (which is attacker-
-- controlled at presign). Only passive kinds ('pdf', 'image') may render inline; any
-- bytes that don't sniff to a known passive type are 'none' → download card only
-- (HTML/SVG/active content can never reach an inline frame — stored-XSS boundary).
-- Existing rows default to 'none' (fail-closed): attachments confirmed before this
-- migration render as download cards until re-uploaded.
-- The attachments table already carries RLS from its own migration; a column add
-- inherits it.

ALTER TABLE attachments ADD COLUMN inline_kind TEXT NOT NULL DEFAULT 'none'
  CHECK (inline_kind IN ('pdf', 'image', 'none'));
