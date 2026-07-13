// #316 / ADR-123: restoring a page BODY to an old revision must not silently revert live task progress.
// reconcileTaskChecks overlays the CURRENT checkbox states onto the restore target when the task
// COMPOSITION is unchanged (same labels, same order — regardless of prose), and falls back to the target's
// own snapshot states when a task was added / removed / reordered. Pure — no DB / Yjs.
import { describe, it, expect } from 'vitest'
import { reconcileTaskChecks } from '../routes/pages.js'

describe('reconcileTaskChecks (#316 / ADR-123)', () => {
  it('same task composition → keeps CURRENT checked states on the target prose (case a)', () => {
    // current: both done; target revision: both were undone, and had DIFFERENT prose.
    const current = '# Now\n\n- [x] buy milk\n- [x] call bob\n'
    const target = '# Old title\n\nsome older intro\n\n- [ ] buy milk\n- [ ] call bob\n'
    // the restored body is the OLD prose, but the checks reflect CURRENT progress (both stay done)
    expect(reconcileTaskChecks(current, target)).toBe('# Old title\n\nsome older intro\n\n- [x] buy milk\n- [x] call bob\n')
  })

  it('per-task overlay is positional within an unchanged composition', () => {
    const current = '- [ ] a\n- [x] b\n- [ ] c\n'
    const target = '- [x] a\n- [x] b\n- [x] c\n'
    expect(reconcileTaskChecks(current, target)).toBe('- [ ] a\n- [x] b\n- [ ] c\n')
  })

  it('a REMOVED task changes the composition → falls back to the target snapshot states', () => {
    const current = '- [x] a\n- [x] b\n' // "c" is gone now
    const target = '- [ ] a\n- [ ] b\n- [ ] c\n'
    expect(reconcileTaskChecks(current, target)).toBe(target) // untouched fallback (no ordinal mis-map)
  })

  it('a REORDERED task changes the composition → falls back', () => {
    const current = '- [x] b\n- [ ] a\n'
    const target = '- [ ] a\n- [ ] b\n'
    expect(reconcileTaskChecks(current, target)).toBe(target)
  })

  it('a RENAMED/added task label changes the composition → falls back', () => {
    const current = '- [x] buy milk\n- [x] call bob\n'
    const target = '- [ ] buy milk\n- [ ] call barbara\n'
    expect(reconcileTaskChecks(current, target)).toBe(target)
  })

  it('no tasks on either side → the target is returned unchanged', () => {
    expect(reconcileTaskChecks('# a\n\ntext', '# b\n\nother')).toBe('# b\n\nother')
  })

  it('preserves ordered-list markers, indentation, and X casing normalises to lowercase x', () => {
    const current = '1. [X] first\n   - [ ] nested\n'
    const target = '1. [ ] first\n   - [x] nested\n'
    // current: first done (X), nested undone → overlaid onto the target
    expect(reconcileTaskChecks(current, target)).toBe('1. [x] first\n   - [ ] nested\n')
  })
})
