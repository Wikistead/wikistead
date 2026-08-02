-- #578 / ADR-201 rev3 slice 5: the tenant DEFAULT ROLE is retired.
--
-- It conferred a tenant-scope custom role on every member no group mapping matched. The tenant
-- vocabulary is `createSpaces` and `issueApiKeys`, and the same admin screen already carries an
-- every-member toggle for each — so the default role and the toggles were two ways of saying one
-- thing, and ADR-201 kept the toggles.
--
-- CONVERSION, in two halves, because the two halves live in different stores:
--   1. HERE: the assignments the evaluator created (`origin='default'`) become ordinary manual
--      assignments. Nobody loses a capability — the rows and their FGA tuples are untouched; only the
--      claim "the evaluator owns this" goes, and it has to, because the evaluator no longer exists to
--      own anything. Left as 'default' they would be orphans nothing maintains.
--   2. infra/openfga/migrate-578-default-role-toggles.ts: for each tenant that HAD a default role,
--      the role's capabilities are written as the every-member tuples, so the intent ("all members get
--      this") survives the setting that expressed it.
--
-- `tenant_settings.default_role_id` is deliberately NOT dropped here. Its readers went first in this
-- commit; the column follows in a later migration, which is the #499 rule.
UPDATE role_assignments SET origin = 'manual'
WHERE resource_type = 'tenant' AND origin = 'default';
