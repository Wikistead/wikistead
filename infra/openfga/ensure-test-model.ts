// #418 (+#433): pre-test FGA drift heal for the ISOLATED server-test stack.
//
// Runs at the head of `pnpm --filter @wikistead/server test` (inside the same flock).
// See model-drift.ts for the full rationale (stale model pins after a rebase moves
// model.fga; dead store pins after another session recreates the stack). Match →
// sub-second no-op. Never touches .env / .env.server-test — only the worktree-local pin.
import { ensureStackModel } from './model-drift.js'

ensureStackModel({
  label: 'ensure-test-model',
  stack: 'server-test',
  envFiles: ['.env.server-test.local', '.env.server-test'],
  localEnvFile: '.env.server-test.local',
  setupCmd: 'pnpm setup:server-test',
}).catch((e) => {
  console.error('ensure-test-model failed:', e)
  process.exit(1)
})
