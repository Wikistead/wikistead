-- #554 S4 / ADR-197 §1-3: the admin connection-management columns.
--   label   — the tenant-authored button label; rev3: PUBLISHED only for a preset-less custom OIDC
--             connection (presets/platform/SAML wear fixed branding). Hygiene enforced at the API.
--   preset  — 'google' | 'microsoft' | NULL (prefills + brands; the Microsoft preset templates the
--             issuer from the Entra tenant id, review N1).
--   subject_prefix — ADR-197 §5: NEW connections mint member subs as wc<conn8>_<externalSub>; the
--             legacy connection keeps RAW subs (existing members' identity continuity), marked by
--             NULL. Set once at creation, never editable (changing it would orphan every member
--             the connection minted).
ALTER TABLE tenant_oidc ADD COLUMN label TEXT;
ALTER TABLE tenant_oidc ADD COLUMN preset TEXT;
ALTER TABLE tenant_oidc ADD COLUMN subject_prefix TEXT;
