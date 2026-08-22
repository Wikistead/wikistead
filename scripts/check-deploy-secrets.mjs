#!/usr/bin/env node
// #147 / ADR-042 (ruling item 4): no plaintext credential enters the deploy manifests.
//
// The two that were committed before SOPS existed — `POSTGRES_PASSWORD: app` and the OpenFGA
// datastore URI with its password inline — are GONE (#147 encrypted to the dev age key under
// deploy/k8s/secrets/, referenced by secretKeyRef). The ledger below is therefore empty, and this
// guard's whole job is keeping it that way: a plaintext credential committed once is in the history
// for ever, so it has to be rotated rather than deleted — the failure is one-way, which is why this
// fails before the commit rather than after.
//
// The shape is the ledger #623 uses: known plaintext would be listed WITH ITS REASON, anything else
// fails, and the list shrinking is how anybody can tell the promise was kept. It is deliberately not
// a `grep` for passwords — asked for an allowlist of KEYS whose value must not be inline,
// because grepping for secret-looking strings finds every example in every comment and gets switched
// off. `*.enc.yaml` is exempt: its values are ciphertext by definition, and `.sops.yaml` pins which
// age recipient every such file encrypts to.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
// ⚠️ TWO roots since #802. The Helm chart is a second place deployment material is authored, and it
// renders the same Secrets — a check that walks only `deploy/` would have said "no plaintext
// credentials" about a tree it never opened. Measured when the chart landed: the walk reported OK
// with charts/ outside it.
const SCAN_ROOTS = [join(root, 'deploy'), join(root, 'charts')].filter((d) => existsSync(d))

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
  // Empty since #147 repaid the debt (both former entries are SOPS-encrypted Secrets now).
  // A new line here is a new promise with a ticket number attached — not an exemption.
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
const files = SCAN_ROOTS.flatMap((d) => walk(d))
// #719: a walk that silently stopped finding files would pass by having nothing to judge.
if (files.length === 0) { console.error('check-deploy-secrets: walked 0 files — the scan found nothing to read'); process.exit(1) }
let scanned = 0
for (const file of files) {
  scanned++
  // `*.enc.yaml` is the encrypted form — its values are ciphertext by definition.
  if (/\.enc\.ya?ml$/.test(file)) continue
  const rel = relative(root, file).replace(/^deploy\//, '')
  const src = readFileSync(file, 'utf8')
  // `{ name: FOO_PASSWORD, value: … }` and the multi-line `- name:` / `value:` form both appear in
  // this tree, so the name and the value are matched on one line OR remembered across two. The
  // carry-over is real (#147 measured the earlier version matching only the inline form, so a
  // credential written on two lines walked straight past the guard the comment claimed would catch
  // it). `valueFrom:` on the following line is the CORRECT form and clears the carried name.
  let carried = null
  for (const line of src.split('\n')) {
    // A comment is prose, not a manifest. Without this the guard reports its own explanation.
    if (/^\s*#/.test(line)) continue
    // ⚠️ #802: a Helm template expression is not a literal in git. `{{ .Values… }}`, `{{ include … }}`
    // and Kubernetes' own `$(VAR)` substitution all render elsewhere — the FIRST of these is what the
    // chart uses for every credential, and flagging them would push somebody to silence the guard on
    // the one tree it was just taught to read. What still fires here is a real value: a quoted string,
    // a URI with userinfo, a generator literal.
    const templated = /\{\{|\$\(/.test(line)
    const flagAlways = (name) => {
      if (templated) return
      const key = `${rel}:${name}`
      if (seen.has(key)) return
      seen.add(key)
      if (!(key in KNOWN)) offenders.push(key)
    }
    const flag = (name) => {
      if (!SECRET_SUFFIXES.some((s) => name.endsWith(s))) return
      flagAlways(name)
    }
    const inline = /name:\s*([A-Z][A-Z0-9_]*)\s*,\s*value:\s*\S/.exec(line)
    if (inline) { flag(inline[1]); carried = null; continue }
    const nameOnly = /-\s*name:\s*([A-Z][A-Z0-9_]*)\s*$/.exec(line)
    if (nameOnly) { carried = nameOnly[1]; continue }
    if (carried && /^\s*value:\s*\S/.test(line)) flag(carried)
    carried = null

    // Arm 2 (#147, measured): kustomize GENERATOR LITERALS — `- some-key=value` — are Secret
    // objects in the cluster but plaintext in git, and the env-var arms above never see them (the
    // dev overlay's meili/s3/guest-token literals all walked past the first version of this guard).
    // Keys here are lower-dashed, so the suffix match is case-insensitive.
    const literal = /^\s*-\s*([A-Za-z][A-Za-z0-9_.-]*)=(\S)/.exec(line)
    if (literal && SECRET_SUFFIXES.some((s) => literal[1].toUpperCase().replaceAll('-', '_').endsWith(s))) {
      flagAlways(literal[1])
    }

    // Arm 3 (#147, measured): a URI whose userinfo embeds a password is a credential whatever
    // its key is called — `DATABASE_URL=postgres://app:app@…` ends in `_URL`, not `_URI`, and the
    // allowlist arms above waved it through. Values only; comments were skipped at the top, so this
    // cannot fire on prose (the reason the guard is not a grep).
    const userinfo = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:[^/\s@'"]+@/.exec(line)
    if (userinfo) {
      const named = /(?:name:\s*|-\s*)([A-Za-z][A-Za-z0-9_.-]*)[=:]/.exec(line)
      flagAlways(named ? named[1] : 'uri-with-userinfo')
    }
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

console.log(
  `OK: no plaintext credentials in ${SCAN_ROOTS.map((d) => `${d.split('/').pop()}/`).join(' + ')} ` +
  `(${scanned} file(s) read, ${seen.size} secret-shaped inline values, ${Object.keys(KNOWN).length} on the ledger)`,
)
