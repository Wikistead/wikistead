-- Migration 134: SCIM offboarding deferral (#983 / ADR-275 rev3 §1, slice #1049).
--
-- A SCIM deactivate the fortress must refuse — last admin (#573), last sign-in administrator (#925) —
-- is no longer a 409 the IdP re-pushes forever: it is recorded here as a PENDING removal and executed
-- once it becomes safe (the reconciler, ADR-275 §3). A member carrying these columns is FULLY ACTIVE:
-- seated, billable, able to sign in. This is deliberately not a fifth `deactivation_reason`
-- (ADR-275 §"Not a new state"): the predicates that read `deactivated_at` / `deactivation_reason`
-- (`grantsShouldBeRebuilt`, `isScimSuspension`, `billableMemberCount`) keep their answers untouched.
--
-- The CHECK is the structural half of the invariant "pending OR deactivated, never both". The other
-- half lives in code: every writer of `deactivated_at = now()` clears both columns in the SAME
-- statement (a discovery pin walks the tree for writers), because whichever path deactivates the
-- member fulfils what the deferred push wanted — the intent is moot, not still owed. Without the
-- code half, an admin's own suspension of a pending member would hit this CHECK and fail.
ALTER TABLE members ADD COLUMN IF NOT EXISTS pending_scim_removal_at TIMESTAMPTZ;
ALTER TABLE members ADD COLUMN IF NOT EXISTS pending_scim_removal_reason TEXT
  CHECK (pending_scim_removal_reason IN ('last_admin', 'login_lockout'));

-- Named, so a later migration can drop or replace it by name.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_pending_xor_deactivated;
ALTER TABLE members ADD CONSTRAINT members_pending_xor_deactivated
  CHECK (deactivated_at IS NULL OR pending_scim_removal_at IS NULL);

-- The two pending columns travel together: a timestamp without a reason (or the reverse) is a
-- half-written state nothing downstream can interpret.
ALTER TABLE members DROP CONSTRAINT IF EXISTS members_pending_pair;
ALTER TABLE members ADD CONSTRAINT members_pending_pair
  CHECK ((pending_scim_removal_at IS NULL) = (pending_scim_removal_reason IS NULL));
