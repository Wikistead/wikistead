// #684 / ADR-223 §3b: the allowlist is enforced by the COMPILER, so this is where it is exercised.
//
// A type-level claim cannot be asserted by a runtime test — the code either compiles or it does not.
// This file is compiled by the same `tsc --noEmit` the merge gate runs, so widening
// `AuditChangeField` to `string` turns the directive below into an unused `@ts-expect-error` and the
// gate fails. That is the pin.
//
// It is not a test file (no `.test.ts`), so vitest never runs it; `audit-changes-bounds-684` reads it
// to assert the directive is still here, because a probe that was quietly emptied would also compile.
import type { AuditChanges } from '../audit/outbox.js'

// The field this ADR opened. Permitted, and it typechecks.
export const allowed: AuditChanges = { second_factor_kinds: { from: 'any', to: 'passkey' } }

// @ts-expect-error a factor's label is what a MEMBER wrote about their own device (§3): it names no
// tenant object, and it would be published to every holder of `view_audit` in a row nothing can amend.
export const refused: AuditChanges = { factor_label: { from: 'my phone', to: 'work key' } }
