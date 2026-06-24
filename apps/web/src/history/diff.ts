// Line-level diff via a longest-common-subsequence backtrace (ADR-019 D6: no
// dependency — a standard algorithm, not a reinvented wheel). O(m·n) time/space, which
// is ample for page-sized Markdown. Operates on the raw Markdown text, so a toggled task
// checkbox (`- [ ] x` → `- [x] x`) shows up as a changed line like any other edit (D7).
export type DiffLine = { type: "add" | "del" | "same"; text: string };

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];
  const m = a.length;
  const n = b.length;

  // dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "del", text: a[i++] });
  while (j < n) out.push({ type: "add", text: b[j++] });
  return out;
}

// ── Split (side-by-side) view ───────────────────────────────────────────────
// Reuse the SAME line-LCS alignment, laid out in two columns: left = the revision
// (old), right = the current published (new). A maximal run of deletions followed by
// additions is zipped index-wise into paired rows (so a one-line edit — e.g. a checkbox
// flip `- [ ] x` → `- [x] x` — becomes a single "change" row with old on the left and
// new on the right); surplus deletions/additions become left-only / right-only rows.
// No new dependency — purely a transform over lineDiff's output.
export type DiffSide = { lineNo: number; text: string } | null;
export type DiffRow = { left: DiffSide; right: DiffSide; type: "same" | "add" | "del" | "change" };

export function sideBySide(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let dels: DiffSide[] = [];
  let adds: DiffSide[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      const left = dels[k] ?? null;
      const right = adds[k] ?? null;
      rows.push({ left, right, type: left && right ? "change" : left ? "del" : "add" });
    }
    dels = [];
    adds = [];
  };
  for (const l of lineDiff(oldText, newText)) {
    if (l.type === "del") dels.push({ lineNo: ++oldNo, text: l.text });
    else if (l.type === "add") adds.push({ lineNo: ++newNo, text: l.text });
    else {
      flush();
      rows.push({ left: { lineNo: ++oldNo, text: l.text }, right: { lineNo: ++newNo, text: l.text }, type: "same" });
    }
  }
  flush();
  return rows;
}

export function rowsHaveChanges(rows: DiffRow[]): boolean {
  return rows.some((r) => r.type !== "same");
}
