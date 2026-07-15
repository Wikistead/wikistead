// #433: pre-suite FGA drift heal for the ISOLATED e2e stack.
//
// Runs at the head of `pnpm --filter @wikistead/e2e e2e` (inside the same flock),
// BEFORE Playwright spawns the API/collab webServers — so the servers always launch
// with pins that match this worktree's model.fga and the live e2e store. See
// model-drift.ts for the full rationale. Match → sub-second no-op. Never touches
// .env / .env.e2e — only the worktree-local .env.e2e.local pin file.
import { ensureStackModel } from './model-drift.js'

ensureStackModel({
  label: 'ensure-e2e-model',
  stack: 'e2e',
  envFiles: ['.env.e2e.local', '.env.e2e'],
  localEnvFile: '.env.e2e.local',
  setupCmd: 'pnpm setup:e2e',
}).catch((e) => {
  console.error('ensure-e2e-model failed:', e)
  process.exit(1)
})
