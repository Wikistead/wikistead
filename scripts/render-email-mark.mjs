// Render the bundled MAIL logo from the product mark. Run: `node scripts/render-email-mark.mjs`
//
// #597: mail needs a raster (Gmail and Outlook draw nothing for an `<img>` pointing at an SVG), and the
// first cut of that raster invented a look for it — a black tile with the glyph knocked out, which is
// not how this product wears its mark anywhere else. The ruling: a technical constraint buys you a
// format change, not a design change. So this script exists to make the raster a FAITHFUL export and to
// leave a trail, because the previous version had no trail and the next person would have redrawn it.
//
// What it does: takes `apps/web/public/favicon.svg` — the mark's canonical geometry — and rasterises it
// unchanged except for the two things a PNG must decide.
//
//   SIZE. Mail draws the mark at 24px (email/layout.ts). 96px is 4x, which covers the retina case and
//   still weighs ~2KB.
//
//   COLOUR. The app strokes the mark in `currentColor`, so on screen it is the foreground: near-black on
//   light, near-white on dark. A PNG has to pick one. The choice here is the palette's own MID-TONE —
//   `#6e7781`, between light `--fg` (#1f2328) and dark `--fg` — so the glyph reads on a white mail
//   background AND on a dark-mode client, which paints its own background behind a transparent PNG.
//
//   The alternative, a `<picture>` with a light and a dark asset, was rejected for a concrete reason:
//   Gmail — the client this whole raster exists for — does not honour it, so every Gmail reader would
//   get the first `<img>`, i.e. the light-mode asset, sunk into a dark background. Two files, same bug.
//
//   The background stays TRANSPARENT. Baking a tile is what the ruling refused.
//
// The mark's own SHA is recorded below. If favicon.svg changes, the pin in
// `apps/server/src/__tests__/email-branding-575.test.ts` goes red and tells you to re-run this — which
// is the only way a derived asset stays derived.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SOURCE = 'apps/web/public/favicon.svg'
export const OUTPUT = 'apps/web/public/icon-email.png'
export const STROKE = '#6e7781' // the palette mid-tone; see the note above before changing it
export const SIZE = 96
/** sha256 of SOURCE at the time OUTPUT was rendered. Mismatch = the mark moved, the mail logo did not. */
export const MARK_SHA = '5d59444196db5a3a86cc534fc07b0b65694df796cd7b26f9e6ca5c6164c810c3'

export const markSha = (repo = REPO) =>
  createHash('sha256').update(readFileSync(resolve(repo, SOURCE))).digest('hex')

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\/scripts/, 'scripts'))) {
  const svg = readFileSync(resolve(REPO, SOURCE), 'utf8')
    .replace(/width="\d+" height="\d+"/, `width="${SIZE}" height="${SIZE}"`)
    .replace(/currentColor/g, STROKE)
  const tmp = resolve(REPO, 'apps/web/public/.email-mark.tmp.svg')
  writeFileSync(tmp, svg)
  try {
    // -background none keeps the transparency; ImageMagick is a build-box tool, not a dependency of the
    // product, which is why this is a script you run rather than a step in the build.
    execFileSync('convert', ['-background', 'none', tmp, '-strip', resolve(REPO, OUTPUT)])
  } finally {
    unlinkSync(tmp)
  }
  console.log(`${OUTPUT} rendered from ${SOURCE} (${SIZE}px, ${STROKE}); MARK_SHA = ${markSha()}`)
}
