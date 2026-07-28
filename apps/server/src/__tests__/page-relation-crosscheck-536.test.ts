// #536 re-review, approval condition 2: the page scope has TWO capability→relation tables again — the
// assignment expansion (roles.ts PAGE_CAP_RELATION + its manage branch) and the grant fallback's
// fgaRelationForCap (pages.ts). They agree today, and #485 came from exactly this shape: two tables kept
// equal by two people. Worse, fgaRelationForCap ends in a NON-exhaustive default (`return
// 'comment_direct'`), so a future PageRelation with no case added falls to comment_direct silently —
// a grant of the new capability would write the COMMENT leaf and report success.
//
// The space scope solved this with one shared table (space-grant-expansion.ts); folding the page tables
// together is a larger move on a hot authz file, so until that lands this pin makes the drift loud:
// every relation must expand to the same leaf on both sides, and the manage superset stays built-in-only.
import { describe, it, expect } from 'vitest'
import { fgaRelationForCap, type PageRelation } from '../routes/pages.js'
import { expansionTuples } from '../routes/roles.js'

const ALL: PageRelation[] = ['view', 'comment', 'edit', 'manage', 'moderate', 'delete', 'share', 'settings', 'publish']

describe('#536: the two page capability→relation tables cannot drift', () => {
  it.each(ALL)('"%s" expands to the same leaf on the grant path and the assignment path', (cap) => {
    const grantLeaf = fgaRelationForCap(cap)
    // manage is the built-in superset — the assignment path only reaches it with allowSuperset, exactly
    // as grantPageAccess calls it
    const tuples = expansionTuples('page', 'p1', 'user:u1', cap as never, cap === 'manage')
    expect(tuples).toHaveLength(1)
    expect(tuples[0]!.relation, `both tables agree on ${cap}`).toBe(grantLeaf)
    expect(tuples[0]!.object).toBe('page:p1')
  })

  it('manage without the superset flag is refused, not defaulted', () => {
    // The second layer of the two-layer defence, pinned where the drift pin lives: a custom role that
    // somehow carries `manage` (the vocabulary check is the first layer) must 400 at expansion, never
    // fall through to some other leaf.
    expect(() => expansionTuples('page', 'p1', 'user:u1', 'manage' as never, false)).toThrow(/not assignable/)
    expect(() => expansionTuples('space', 's1', 'user:u1', 'manage' as never, false)).toThrow(/not assignable/)
  })
})
