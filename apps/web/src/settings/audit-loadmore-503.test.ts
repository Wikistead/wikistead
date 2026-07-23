// #503 the audit list's EXPLICIT end state. The old rows.length % 50 heuristic failed both
// ways — an exact-multiple total kept "load more" alive forever (clicking appended an empty page and
// visibly did nothing), and a fractional total made the button vanish silently with no "that's all"
// signal. auditListState derives the end from the LAST FETCHED PAGE being shorter than the limit
// (empty included). Red without the fix: auditListState does not exist on master (the component
// inlined the heuristic), so these pins fail at import.
import { describe, it, expect } from 'vitest'
import { auditListState, AUDIT_PAGE_LIMIT } from './AdminAuditTab'

const page = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ seq: offset + i }))

describe('auditListState (#503 end-state)', () => {
  it('exact-multiple total: the empty follow-up page ends the list instead of a live no-op button', () => {
    // 100 rows total — two full pages, then the click that used to be a visible no-op returns [].
    const full1 = page(AUDIT_PAGE_LIMIT, 0)
    const full2 = page(AUDIT_PAGE_LIMIT, 50)
    const beforeClick = auditListState(full1, [full1, full2])
    expect(beforeClick.canLoadMore).toBe(true) // two full pages: the end is not yet known
    expect(beforeClick.showEndNotice).toBe(false)

    const afterEmpty = auditListState(full1, [full1, full2, []])
    expect(afterEmpty.rows.length).toBe(100) // the empty page adds nothing…
    expect(afterEmpty.canLoadMore).toBe(false) // …and the button goes away (old heuristic: 100 % 50 === 0 kept it)
    expect(afterEmpty.showEndNotice).toBe(true) // …with an explicit "that's all" signal
  })

  it('fractional total: the short last page ends the list WITH a signal instead of a silent vanish', () => {
    const full = page(AUDIT_PAGE_LIMIT, 0)
    const short = page(20, 50)
    const s = auditListState(full, [full, short])
    expect(s.rows.length).toBe(70)
    expect(s.canLoadMore).toBe(false)
    expect(s.showEndNotice).toBe(true) // old behaviour: button silently gone, no end marker
  })

  it('a log that fits its first page never shows the button OR the end marker (no noise)', () => {
    const s = auditListState(page(30), [])
    expect(s.canLoadMore).toBe(false)
    expect(s.showEndNotice).toBe(false)
  })

  it('a full first page offers load-more without an end marker', () => {
    const s = auditListState(page(AUDIT_PAGE_LIMIT), [])
    expect(s.canLoadMore).toBe(true)
    expect(s.showEndNotice).toBe(false)
  })

  it('empty and unloaded logs are inert', () => {
    expect(auditListState([], [])).toMatchObject({ rows: [], canLoadMore: false, showEndNotice: false })
    expect(auditListState(undefined, [])).toMatchObject({ rows: [], canLoadMore: false, showEndNotice: false })
  })
})
