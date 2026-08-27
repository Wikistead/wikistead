// ADR-253 §3.2: where `infra/openfga/model.fga` is, asked in a way that survives being deployed.
//
// The guard used to resolve one path — `../../../infra/openfga/model.fga` from its own module — the
// repository's layout and only the repository's, which lands outside the image entirely. Modelled on
// `migrations-dir.ts` (#804), with one difference on purpose: there is no operator override here. An
// operator's SQL is ALLOWED to differ from the image's (`MIGRATIONS_DIR` exists for exactly that); an
// authorization model is the one artefact where it may not (ADR-253 §3.2). So there are two
// candidates, never three, and neither is named by an environment variable.
import { resolve } from 'node:path'

/** The places `model.fga` can be, in the order they win. Never influenced by `process.env`. */
export function modelDslPathCandidates(moduleDir: string): string[] {
  return [
    // The deploy tree: the image copies the DSL beside the package (/app/model.fga, with the guard
    // at /app/dist/openfga-guard.js).
    resolve(moduleDir, '..', 'model.fga'),
    // The repository: apps/server/{src,dist} → repo root → infra/openfga/model.fga. Both the tsx
    // run and the compiled run sit at the same depth, which is why one entry covers both.
    resolve(moduleDir, '..', '..', '..', 'infra', 'openfga', 'model.fga'),
  ]
}

export type ModelDslPathChoice =
  | { kind: 'found'; path: string }
  | { kind: 'none'; candidates: string[] }

/**
 * The first candidate that exists, or a refusal naming both it looked in — never a guess. A boot
 * that cannot read the model it is supposed to speak refuses in words (ADR-253 §3.2, §6): a resolver
 * that returns nothing hands `undefined` down the line, and something further in throws anyway, so a
 * pin watching only the exit code would stay green under the mutation it exists to catch.
 */
export function chooseModelDslPath(moduleDir: string, exists: (path: string) => boolean): ModelDslPathChoice {
  const candidates = modelDslPathCandidates(moduleDir)
  for (const candidate of candidates) if (exists(candidate)) return { kind: 'found', path: candidate }
  return { kind: 'none', candidates }
}
