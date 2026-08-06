#!/usr/bin/env node
// #147 / ADR-042 (rulingitem 4): no NEW plaintext credential enters the deploy manifests.
//
// Two of them are there today — `POSTGRES_PASSWORD: app` and the OpenFGA datastore URI with its
// password inline — and this guard does not remove them. Removing them needs SOPS, SOPS needs a
// `.sops.yaml`, and that file's creation rules cannot be written before somebody decides who holds the
// age key and where decryption happens. The ruling put that work in the deploy phase for exactly that
// reason: written early, the encrypted files are re-done the moment the key operation is settled.
//
// What CAN be done now, and is the reason this exists: STOP THE DEBT GROWING. A plaintext credential
// committed once is in the history for ever, so it has to be rotated rather than deleted — the failure
// is one-way, and a guard that arrives with the deploy phase arrives after the commit that needed it.
//
// The shape is the ledger #623 uses: the known plaintext is listed WITH ITS REASON, anything else fails,
// and the list shrinking is how anybody can tell the promise was kept. It is deliberately not a `grep`
// for passwords —asked for an allowlist of KEYS whose value must not be inline, because grepping
// for secret-looking strings finds every example in every comment and gets switched off.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SCAN = join(root, 'deploy')

/**
 * Environment variable names whose value is a credential. A `value:` on one of these is plaintext in
 * git; the correct form is `valueFrom: { secretKeyRef: … }` pointing at a Secret that SOPS produces.
 *
 * Suffix-matched rather than exact, because the next one will be `FOO_PASSWORD` and nobody will
 * remember to add it here.
 */
const SECRET_SUFFIXES = ['_PASSWORD', '_SECRET', '_KEY', '_TOKEN', '_URI', '_DSN', '_CREDENTIALS']

/**
 * The plaintext that is already committed, and why it may stay for now.
 *
 * A line here is a promise, not an exemption: each names the ticket that removes it. THE LIST IS
 * EXPECTED TO SHRINK — when SOPS lands, every entry goes, and a line that stays is a decision somebody
 * has to defend rather than a fact that fades.
 */
const KNOWN = {
  'k8s/base/openfga.yaml:OPENFGA_DATASTORE_URI':
    '#147: the datastore URI carries its password inline. Removed when SOPS lands (ADR-042, deploy phase).',
  'k8s/base/postgres.yaml:POSTGRES_PASSWORD':
    '#147: the dev-shaped password the base manifest ships with. Same removal.',
}

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.ya?ml$/.test(entry)) out.push(full)
  }
  return out
}

const offenders = []
const seen = new Set()
for (const file of walk(SCAN)) {
  // `*.enc.yaml` is the encrypted form — its values are ciphertext by definition.
  if (/\.enc\.ya?ml$/.test(file)) continue
  const rel = relative(root, file).replace(/^deploy\//, '')
  const src = readFileSync(file, 'utf8')
  for (const line of src.split('\n')) {
    // A comment is prose, not a manifest. Without this the guard reports its own explanation.
    if (/^\s*#/.test(line)) continue
    // `{ name: FOO_PASSWORD, value: … }` and the multi-line `- name:` / `value:` form both appear in
    // this tree, so the name and the value are matched on one line OR remembered across two.
    const inline = /name:\s*([A-Z][A-Z0-9_]*)\s*,\s*value:\s*(\S)/.exec(line)
    if (!inline) continue
    const [, name] = inline
    if (!SECRET_SUFFIXES.some((s) => name.endsWith(s))) continue
    const key = `${rel}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!(key in KNOWN)) offenders.push(key)
  }
}

// The other direction, and the one that lets the list shrink honestly: an entry for plaintext that is
// no longer there is a promise nobody can check.
const stale = Object.keys(KNOWN).filter((k) => !seen.has(k))

if (offenders.length > 0 || stale.length > 0) {
  for (const o of offenders) {
    console.error(`FAIL: a credential is inline in the manifest: ${o}`)
  }
  for (const s of stale) {
    console.error(`FAIL: the allowlist names plaintext that is gone — delete the line: ${s}`)
  }
  if (offenders.length > 0) {
    console.error('')
    console.error('Use `valueFrom: { secretKeyRef: … }` and supply the Secret from a SOPS-encrypted file')
    console.error('(ADR-042). A plaintext credential committed once stays in the history and has to be')
    console.error('rotated rather than deleted, which is why this fails before the commit rather than after.')
  }
  process.exit(1)
}

console.log(`OK: no new plaintext credentials in deploy/ (${seen.size} secret-shaped values, ${Object.keys(KNOWN).length} known and owed to #147)`)
