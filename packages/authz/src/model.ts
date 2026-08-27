import { transformer } from '@openfga/syntax-transformer'

// #253: the DSL → authorization-model transform and its canonical comparison, in one place.
// `apps/server/src/openfga-guard.ts` and `infra/openfga/model-drift.ts` each kept their own copy
// of both — this replaces both rather than joining a third copy to them (ADR-253 §3.5).

/** `infra/openfga/model.fga`'s DSL text, transformed into the shape OpenFGA's write API expects. */
export function dslToModel(dsl: string): unknown {
  return transformer.transformDSLToJSONObject(dsl)
}

// Canonicalize for comparison: sort object keys recursively; drop the server-added `id` field,
// and null/undefined/EMPTY values — arrays, objects, and strings (the read-back API fills
// defaults the DSL transform omits: `generic_types: []`, `module: ""`, `condition: ""`) — all
// meaning "absent".
export function canonicalModel(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(canonicalModel).filter((x) => x !== undefined)
    return arr.length ? arr : undefined
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (k === 'id') continue
      const val = canonicalModel((v as Record<string, unknown>)[k])
      if (val === undefined || val === null) continue
      out[k] = val
    }
    return Object.keys(out).length ? out : undefined
  }
  if (v === '') return undefined
  return v ?? undefined
}

/** Content equality via {@link canonicalModel}, not reference or id equality. */
export function modelsMatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalModel(a)) === JSON.stringify(canonicalModel(b))
}
