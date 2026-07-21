-- Migration 078: who may issue an API key in this tenant (#462).
--
-- The issuing UI lived only in the admin console, so in practice keys were an admin thing — but the
-- server never enforced that: POST /api-keys checked the plan entitlement and the scope ceiling and
-- nothing else, so any member could mint their own key by calling the API directly. The tenant now
-- says which it wants, and the SERVER enforces it either way.
--
-- NULL = 'members', the behaviour the server has always had — so no existing tenant changes when
-- this lands, and a tenant that wants the stricter rule opts into it.
ALTER TABLE tenant_settings ADD COLUMN api_key_issue_policy TEXT;
