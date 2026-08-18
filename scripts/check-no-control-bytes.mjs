#!/usr/bin/env node
// #744: no RAW control byte in a tracked text file. Run: pnpm lint:no-control-bytes
//
// A single NUL is enough for git to call a source file BINARY, and a binary file has no diff. Nine
// files were in that state, three of them (`routes/pages.ts`, `routes/comments.ts`,
// `search/cursor.ts`) the authorisation and pagination code — so a change to a permission check
// showed up in review as `Binary files a/… and b/… differ`, and a merge could only take one whole
// side of them rather than resolving line by line. It is also precisely the shape that cannot be
// reviewed by somebody outside this repository, which #727 / #293 are working towards.
//
// None of the offenders meant to write a raw byte. Two shapes produced them:
//   * a composite key using NUL as a separator that cannot occur in the data — a good idea, written
//     as the byte itself instead of as `\x00`;
//   * a regex character class, `[^\x00-\x7f]`, whose escapes were resolved into real bytes at some
//     point and saved that way. Same behaviour, unreadable source.
// Both keep working identically when the byte is written as an escape, which is what the fix did:
// the separators are still NUL, the hashes and cursors they feed are byte-for-byte what they were.
//
// DISCOVERY, not a list: it walks everything git tracks rather than holding the names of the nine,
// so a tenth file is red on the commit that adds it. That is the whole difference between this and
// the one-off cleanup — this repository has watched three hand-written pins go stale in a week.
//
// SCOPE, stated rather than implied:
//   * TAB, LF and CR are text, and are not searched for.
//   * Binary files (images, fonts, archives) are excluded BY EXTENSION, and the excluded extensions
//     are printed. An exclusion nobody can see is how a scan quietly stops covering things.
//   * DEL (0x7f) and the C1 range (0x80-0x9f) are not control bytes to git, and none of them makes a
//     file binary — but a source file cannot be read with them in it either, and two of the nine had
//     a raw DEL inside that same character class. They are in scope for the same reason as the rest.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')

/** Files whose content is not text. Listed by extension, and printed, so the hole is visible. */
const BINARY = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.zip', '.gz', '.br', '.mp4', '.webm', '.wasm', '.node', '.keystore', '.jks']

/** Text, minus the three control characters that ARE text. */
const isControl = (b) => (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) || b === 0x7f || (b >= 0x80 && b <= 0x9f)

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8').split('\0').filter(Boolean)

const scanned = []
const offenders = []
for (const rel of tracked) {
  if (BINARY.some((ext) => rel.toLowerCase().endsWith(ext))) continue
  const full = join(root, rel)
  let bytes
  try {
    if (!statSync(full).isFile()) continue
    bytes = readFileSync(full)
  } catch { continue } // a submodule or a path removed since `ls-files` ran
  scanned.push(rel)
  const hits = []
  let line = 1
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) { line++; continue }
    // A UTF-8 continuation byte is in the C1 range on its own; only a LEAD byte starts a character,
    // so anything 0x80-0xbf that follows one is part of a perfectly ordinary character. Skipping the
    // whole multi-byte sequence is what keeps this from reporting every Japanese page in the tree.
    if (bytes[i] >= 0xc2) {
      const len = bytes[i] >= 0xf0 ? 4 : bytes[i] >= 0xe0 ? 3 : 2
      i += len - 1
      continue
    }
    if (isControl(bytes[i])) hits.push({ line, byte: bytes[i] })
  }
  if (hits.length) offenders.push({ rel, hits })
}

// A scan that finds nothing to scan agrees with every possible state of the tree.
if (scanned.length < 100) {
  console.error(`FAIL: only ${scanned.length} tracked text file(s) scanned — the walk is broken, not the tree clean`)
  process.exit(1)
}

if (offenders.length) {
  for (const { rel, hits } of offenders) {
    const where = hits.map((h) => `line ${h.line} (0x${h.byte.toString(16).padStart(2, '0')})`).join(', ')
    console.error(`FAIL: raw control byte in ${rel}: ${where}`)
  }
  console.error('')
  console.error('A NUL makes git treat the file as BINARY, so its diff disappears from review and from')
  console.error('merges. Write the byte as an escape instead (`\\x00` in a template literal or a regex')
  console.error('class) — the value is identical and the file stays readable.')
  process.exit(1)
}

console.log(`OK: ${scanned.length} tracked text file(s) scanned, no raw control bytes (binary extensions skipped: ${BINARY.join(' ')}).`)
