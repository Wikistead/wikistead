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

// True when the two texts are identical (no add/del lines) — lets the UI show a
// "no changes" hint instead of an all-context wall.
export function hasChanges(lines: DiffLine[]): boolean {
  return lines.some((l) => l.type !== "same");
}
