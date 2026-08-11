// #178 / ADR-084 (2026-08-12 addendum): the ONE place that knows where EE server source lives.
//
// The EE sources are mid-move: today they sit at `packages/ee-server`; the two-repo overlay puts them
// at `ee/packages-ee/ee-server` (a separate, gitignored upstream cloned in by dev-bootstrap.sh);
// a public CE clone has them nowhere at all. Five CE-side consumers need that answer — the e2e
// web-server command (which runs the EE composition root) and the CE test sweeps that read EE files as
// data — and five hard-coded paths would each go quietly stale on move day, every one of them by
// SILENTLY DROPPING COVERAGE rather than by failing. So the path knowledge lives here and nowhere
// else; a pin (ee-overlay-prewire-178.test.ts) keeps new hard-coded copies from growing back.
//
// Three answers, not two:
//   - a path       — EE source found (pre- or post-move home);
//   - null         — genuinely CE-only (no overlay at all): sweeps cover CE, e2e runs the CE entrypoint;
//   - an EXCEPTION — an `ee/` overlay EXISTS but ee-server is not at the known layout. This is the
//     case that must not degrade to null: a bootstrapped dev tree where the overlay drifted from this
//     file's candidates would otherwise run "CE-only" e2e and CE-only sweeps while looking green
//     ("skipped" is not green), which on an AGPL-boundary repo is how EE coverage dies unnoticed.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Both homes, in precedence order. The overlay path must agree with the workspace globs
 * dev-bootstrap.sh appends (`ee/packages-ee/*`) — a pin asserts that agreement. */
export const EE_SERVER_SRC_CANDIDATES = [
  'packages/ee-server/src', // pre-move home (current tree)
  'ee/packages-ee/ee-server/src', // post-move home (private overlay, per dev-bootstrap.sh)
]

/** Absolute path to the EE server source root, or null when this is a CE-only tree. */
export function eeServerSourceRoot(repoRoot) {
  for (const candidate of EE_SERVER_SRC_CANDIDATES) {
    const abs = join(repoRoot, candidate)
    if (existsSync(abs)) return abs
  }
  if (existsSync(join(repoRoot, 'ee'))) {
    throw new Error(
      'ee/ overlay is present but ee-server source was not found at any known layout ' +
        `(${EE_SERVER_SRC_CANDIDATES.join(', ')}). ` +
        'Either the overlay drifted or scripts/ee-source-root.mjs needs the new home added — ' +
        'refusing to fall back to CE-only, which would silently drop EE coverage.',
    )
  }
  return null
}

/** Absolute path to the EE composition root (`main.ts`), or null when CE-only. */
export function eeServerMain(repoRoot) {
  const root = eeServerSourceRoot(repoRoot)
  return root ? join(root, 'main.ts') : null
}
