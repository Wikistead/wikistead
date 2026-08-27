// ADR-253 §8②: the one operator-facing escape hatch from the witness's own refusals — deliberately
// re-pointing a deployment at a different store. `resolveFgaForBoot`'s witness-mismatch refusal
// (ADR-253 §3.4) exists precisely so this is never silent; this command is the explicit way through
// it. It deletes the witness ROW only — never a store, a tuple, or a model, in this database or in
// OpenFGA — so the next boot resolves entirely from scratch (§3.1 explicit id, else §3.3 name search,
// else §3.4's `create`). That last case means this is a "forget", not a "rotate": rotating onto a
// KNOWN different store while keeping continuity is `rebindWitness`, used only by the reset-test-store
// tooling, never exposed here.
import postgres from 'postgres'
import { readWitness, forgetWitness } from '../openfga-resolve.js'

/** Returns the witness that was forgotten, or null if there was none to forget. */
export async function forgetOpenFgaStoreBinding(sql: postgres.Sql): Promise<{ storeId: string } | null> {
  const before = await readWitness(sql)
  if (before.kind === 'no-table' || !before.witness) return null
  await forgetWitness(sql)
  return before.witness
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.argv.includes('--yes')) {
    console.error(
      'usage: pnpm openfga:forget-store-binding --yes\n\n' +
        "Deletes this deployment's OpenFGA store-binding witness row ONLY — no store, tuple, or " +
        'model is touched. The next boot resolves a store from scratch (ADR-253 §3.1/§3.3/§3.4), ' +
        'including CREATING A NEW STORE if none is found by name. Use this to deliberately let a ' +
        'deployment re-point at a different store — not to make a witness-mismatch refusal go away ' +
        'without reading what it named first.',
    )
    process.exit(2)
  }
  const sql = postgres(process.env.DATABASE_URL!)
  try {
    const forgotten = await forgetOpenFgaStoreBinding(sql)
    // Named from the row that was there, never from an argument — an operator confirms what they
    // are actually forgetting, not what they typed.
    console.log(
      forgotten
        ? `openfga:forget-store-binding: forgot the binding to store ${forgotten.storeId}`
        : 'openfga:forget-store-binding: no witness row was bound — nothing to forget',
    )
  } finally {
    await sql.end()
  }
}
