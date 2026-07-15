-- #419: tenant default language. v1 SCOPE: used ONLY to localize the personal-space initial name at
-- first login ("Xのスペース" vs "X's Space") — deliberately NOT an app-wide UI locale default (that is
-- a separate design). NULL = 'en' (current behaviour); set per tenant via seed/DB for now (an admin UI
-- knob is a follow-up ticket).
ALTER TABLE tenant_settings ADD COLUMN IF NOT EXISTS default_lang TEXT; -- 'en' | 'ja'; NULL = 'en'
