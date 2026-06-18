// OpenFGA client re-exported from @kb/authz for use within apps/server routes.
// The authoritative FGA primitives (check, writeTuples, etc.) live in packages/authz.
export { fgaClient, check, filterAuthorized, writeTuples, deleteTuples } from '@kb/authz'
