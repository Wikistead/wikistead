// #554 S0 test helper: one import point for the shared validator + the token minter the MCP seam
// pin uses (kept out of the test file so the imports stay tidy).
export { externalSubViolation } from '@wikistead/hooks'
export { mintMcpAccessToken } from '@wikistead/auth'
