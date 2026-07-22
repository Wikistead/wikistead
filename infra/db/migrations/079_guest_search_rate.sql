-- Migration 079: guest search rate caps (#449 / ADR-173 §1).
--
-- Search joins the guest cap family (#328 / ADR-140): a per-link bucket bounds the whole share link,
-- a per-session bucket bounds one guest within it. Same shape as the publish / create-page / attach
-- caps, so a share link opened to the public cannot be turned into a free query firehose against the
-- tenant's Meili + FGA. NULL = unlimited, so a self-host tenant with no config pays nothing.
ALTER TABLE tenant_settings ADD COLUMN abuse_search_rate_link_max INTEGER;
ALTER TABLE tenant_settings ADD COLUMN abuse_search_rate_session_max INTEGER;
