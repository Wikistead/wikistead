-- #684 / ADR-223: the ledger records WHAT CHANGED, not only that something did.
--
-- `tenant.second_factor_required_on` says a policy moved and nothing about the move, so `any → passkey`
-- — a narrowing that signs half a workspace out — is indistinguishable from `passkey → any`, which
-- loosens it. The webhook already carries the pair; the audit log, which is the durable record, does
-- not.
--
-- ⚠️ NULLABLE, and it stays that way. The hash is computed over a POSITIONAL array, so an entry with no
-- `changes` must hash the same six elements it hashes today — that is how every row already written
-- keeps verifying. `audit_log` grants the app role SELECT and INSERT only (043), so there is no
-- re-hashing anything back into agreement if that is got wrong.
--
-- ⚠️ `{}` is normalised to NULL before it is written (in `enqueueAudit`), so ABSENT has exactly one
-- meaning. An empty object would put an entry on the seven-element path while saying nothing.
ALTER TABLE audit_outbox ADD COLUMN IF NOT EXISTS changes JSONB;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS changes JSONB;
