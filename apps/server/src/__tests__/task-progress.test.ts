import { describe, it, expect } from 'vitest'
import { countTodoTasks } from '../task-progress.js'

// #290 / ADR-114: the sidebar aggregate counts checkboxes INSIDE :::todo blocks only (self-gating —
// total>0 ⟺ the page has a :::todo with tasks, so the sidebar ring shows for those pages only).
describe('countTodoTasks (#290)', () => {
  it('counts checkboxes inside a :::todo block', () => {
    const md = ':::todo[Sprint]\n- [x] a\n- [ ] b\n- [ ] c\n:::\n'
    expect(countTodoTasks(md)).toEqual({ done: 1, total: 3 })
  })

  it('IGNORES task checkboxes OUTSIDE a :::todo (the sidebar is :::todo-only,)', () => {
    const md = '- [x] loose one\n- [ ] loose two\n\n:::todo\n- [x] tracked\n:::\n'
    expect(countTodoTasks(md)).toEqual({ done: 1, total: 1 }) // only the one inside :::todo
  })

  it('returns 0/0 for a page with no :::todo (no ring)', () => {
    expect(countTodoTasks('# Title\n\n- [x] not in a todo\n')).toEqual({ done: 0, total: 0 })
    expect(countTodoTasks('just prose')).toEqual({ done: 0, total: 0 })
    expect(countTodoTasks(null)).toEqual({ done: 0, total: 0 })
  })

  it('handles an empty :::todo (0/0) and multiple :::todo blocks', () => {
    expect(countTodoTasks(':::todo\njust a note\n:::\n')).toEqual({ done: 0, total: 0 })
    const two = ':::todo\n- [x] a\n:::\n\ntext\n\n:::todo\n- [ ] b\n- [x] c\n:::\n'
    expect(countTodoTasks(two)).toEqual({ done: 2, total: 3 })
  })

  it('counts ordered task items and nested (indented) ones', () => {
    const md = ':::todo\n1. [x] first\n  - [ ] nested\n:::\n'
    expect(countTodoTasks(md)).toEqual({ done: 1, total: 2 })
  })
})
