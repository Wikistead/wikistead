-- Migration 136: tenant_sweep_progress.manifest_id ON DELETE CASCADE (ADR-252 §1, #810).
--
-- review c-a4180fb (independent review of 135): the FK migration 135 wrote had no ON DELETE
-- clause, defaulting to NO ACTION — deleting a `tenant_sweep_manifests` row while its
-- `tenant_sweep_progress` row still exists would be BLOCKED, forcing every future caller to remember a
-- two-statement delete order (progress, then manifest). The two rows share one lifecycle by
-- construction (135's own comment: "a small global table... progress is recorded outside the tenant",
-- one progress row per manifest, no other reader) — a manifest without its progress row is a state
-- nothing in this design ever wants, so CASCADE is not a data-loss risk here the way it would be on a
-- table with independent readers. Migrations are additive-only in this schema (never edit an applied
-- one), hence a follow-up rather than a fix to 135 in place.
ALTER TABLE tenant_sweep_progress DROP CONSTRAINT IF EXISTS tenant_sweep_progress_manifest_id_fkey;
ALTER TABLE tenant_sweep_progress ADD CONSTRAINT tenant_sweep_progress_manifest_id_fkey
  FOREIGN KEY (manifest_id) REFERENCES tenant_sweep_manifests(id) ON DELETE CASCADE;
