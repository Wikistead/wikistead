// #554 / ADR-197 §5 (S0): thin re-export — the reserved-sub grammar is a cross-boundary identity
// contract (CE seams AND the EE SCIM seam enforce it), so the one definition lives on the published
// hooks surface, where ee-server can import it without touching CE application internals.
export { RESERVED_SUB_RE, MAX_EXTERNAL_SUB_LENGTH, externalSubViolation, assertExternalSub } from '@wikistead/hooks'
