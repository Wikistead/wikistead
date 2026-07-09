// #290 / ADR-114 (increment): count the GFM task checkboxes INSIDE :::todo blocks of a published markdown
// snapshot, for the sidebar progress ring. Pure. The sidebar shows a ring only on pages with a :::todo
//, so counting :::todo-block checkboxes makes `total > 0` self-gating (true exactly for those pages).
// Recomputed on every published_md write (publishPage + toggleTask). Display-only — no authz/search surface.
//
// MVP scope: a top-level `:::todo … :::` block. Enter on a `:::todo` open line, count task lines until the
// next bare `:::` close. (A :::todo nested inside another directive is uncommon; the flat top-level case is
// the promotion target from /todo, ADR-114.) Robust to any colon count on the fence.
const TODO_OPEN = /^\s*:::+todo\b/
const DIR_CLOSE = /^\s*:::+\s*$/
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/

export function countTodoTasks(md: string | null | undefined): { done: number; total: number } {
  let done = 0
  let total = 0
  let inTodo = false
  for (const line of (md ?? '').split('\n')) {
    if (!inTodo) {
      if (TODO_OPEN.test(line)) inTodo = true
      continue
    }
    if (DIR_CLOSE.test(line)) { inTodo = false; continue }
    const m = TASK.exec(line)
    if (m) { total++; if (m[1] !== ' ') done++ }
  }
  return { done, total }
}
