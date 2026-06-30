// "Code is truth" account-settings doc generation (#139 / ADR-080 doc↔code linkage). The settings
// catalog is the SINGLE source the account route validates against AND the generated reference; this
// verifies the render lists every option, is deterministic, and the committed Markdown is not stale
// (same guard `pnpm docs:check` runs in CI).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { KEYMAP_MODES, DISPLAY_MODE_PREFS, REMAPPABLE_COMMANDS, RESERVED_KEYS, renderAccountSettingsMarkdown } from '../settings-catalog.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const generatedPath = join(repoRoot, 'docs/generated/account-settings.md')

describe('account settings doc (#139 / ADR-080 doc↔code linkage)', () => {
  it('render is deterministic and lists every option/command/reserved key', () => {
    const a = renderAccountSettingsMarkdown()
    expect(a).toBe(renderAccountSettingsMarkdown())
    for (const v of [...KEYMAP_MODES, ...DISPLAY_MODE_PREFS, ...REMAPPABLE_COMMANDS, ...RESERVED_KEYS]) {
      expect(a).toContain(`\`${v}\``)
    }
    expect(a).toContain('AUTO-GENERATED')
  })

  it('committed generated doc is NOT stale (CI stale-guard)', () => {
    expect(readFileSync(generatedPath, 'utf8')).toBe(renderAccountSettingsMarkdown())
  })
})
