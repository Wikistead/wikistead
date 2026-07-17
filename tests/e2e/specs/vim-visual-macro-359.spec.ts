import { test, expect, type Page } from "@playwright/test";
import { openScratch, enterEdit, sleep } from "../helpers";

const content = (p: Page) => p.locator("[data-pane=preview] .cm-content").innerText();
const headLine = (p: Page) => p.evaluate(() => (window as Window & { __lpHeadLine?: number }).__lpHeadLine ?? -1);

// #359: in vim × Live, a NON-EMPTY visual selection dragged across a block macro (details/callout/mermaid…) used
// to flip the macro atom↔raw mid-selection (reveal fired on ANY selection overlap), which churned
// `EditorView.atomicRanges` and warped vim's visual head (the project design notes: vim cursor respects atomicRanges). Reveal is
// now an EMPTY-CARET affordance, so a visual selection keeps the macro an atom and the selection extends cleanly.
test("#359: vim V-selection across a :::details keeps it a rendered atom (no reveal, no cursor warp)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openScratch(page, "vim-visual-details-359");
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText("top line\n\n:::details[More info]\nthe hidden body\n:::\n\nbottom line\n");
  await sleep(400);
  await page.getByText("bottom line").click(); // caret off the block → the details renders as an atom box
  await sleep(200);
  const box = page.locator("[data-pane=preview] [data-testid=macro-details]");
  await expect(box).toBeVisible();

  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg"); // top of doc (the "top line")
  await sleep(120);

  // Line-visual from the top, then extend DOWN across the details block. The head must advance one DOC line per
  // `j` (monotonic, no warp), and the details must NEVER reveal its raw `:::details` source (stay an atom).
  await page.keyboard.press("V");
  await sleep(80);
  const lines: number[] = [await headLine(page)];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("j");
    await sleep(80);
    lines.push(await headLine(page));
    expect(await content(page), `step ${i}: details stayed an atom (no raw reveal)`).not.toContain(":::details");
    await expect(box, `step ${i}: the details box is still rendered`).toBeVisible();
  }
  // Head advanced monotonically (never jumped backwards / warped) as the selection grew over the atom.
  for (let i = 1; i < lines.length; i++) expect(lines[i]!, `head line non-decreasing: ${lines}`).toBeGreaterThanOrEqual(lines[i - 1]!);
  expect(lines[lines.length - 1]!, "the selection reached past the block").toBeGreaterThan(lines[0]!);
  // (Empty-caret reveal-to-edit is unchanged — covered by macro-details / mermaid-reveal-243.)
});

// #359symptom 1: ADJACENT (no blank line) atoms chained CM's atomicRanges skip — one `j` jumped
// across ALL touching mermaid blocks (2 → 15 with three blocks at lines 3-6/7-10/11-14). A plain j/k now
// steps ONE atom per press through an adjacency cluster (landing ON each atom, ADR-024 near edge), and
// exits past the last one. Gap-separated atoms keep the default skip-over (the passing case).
const THREE_ADJACENT = "top\n```mermaid\ngraph TD\nA-->B\n```\n```mermaid\ngraph TD\nC-->D\n```\n```mermaid\ngraph TD\nE-->F\n```\nafter\n";
// doc lines: 1=top, m1=2-5, m2=6-9, m3=10-13, 14=after (fences touch — no landable line between)

async function vimReady(page: Page, fixture: string) {
  await openScratch(page, fixture);
  await enterEdit(page);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.insertText(THREE_ADJACENT);
  await sleep(700);
  await page.getByText("after", { exact: true }).click();
  await sleep(200);
  await page.getByTestId("vim-toggle").click();
  await sleep(300);
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Escape");
  await page.keyboard.type("gg");
  await sleep(150);
}

test("#359visual j steps ONE adjacent atom per press (no cluster chain-skip)", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await vimReady(page, "vim-adjacent-visual-359");
  await page.keyboard.press("v");
  await sleep(80);
  const lines: number[] = [await headLine(page)];
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("j");
    await sleep(120);
    lines.push(await headLine(page));
  }
  // One press = one atom: the head visits a line INSIDE each block in turn — never jumping from
  // above the cluster straight past it (the chained bug: 1 → 14 in one press).
  expect(lines[0], `start (timeline ${lines})`).toBe(1);
  const inM1 = lines[1]!, inM2 = lines[2]!, inM3 = lines[3]!, after = lines[4]!;
  expect(inM1, `m1 stop (timeline ${lines})`).toBeGreaterThanOrEqual(2);
  expect(inM1).toBeLessThanOrEqual(5);
  expect(inM2, `m2 stop (timeline ${lines})`).toBeGreaterThanOrEqual(6);
  expect(inM2).toBeLessThanOrEqual(9);
  expect(inM3, `m3 stop (timeline ${lines})`).toBeGreaterThanOrEqual(10);
  expect(inM3).toBeLessThanOrEqual(13);
  expect(after, `exit past the cluster (timeline ${lines})`).toBeGreaterThanOrEqual(14);
});

test("#359normal-mode j/k never chain-skip the cluster (reveal-to-edit stepping intact)", async ({ browser }) => {
  // NORMAL mode has no chain bug: an empty caret entering an atom REVEALS it (reveal-to-edit), so j
  // steps its raw lines — the pin here is that no single press ever jumps the WHOLE cluster (the
  // visual-mode bug shape) and the k mirror walks back up monotonically to the top.
  const page = await (await browser.newContext()).newPage();
  await vimReady(page, "vim-adjacent-normal-359");
  const lines: number[] = [await headLine(page)];
  for (let i = 0; i < 16 && lines[lines.length - 1]! < 14; i++) { await page.keyboard.press("j"); await sleep(100); lines.push(await headLine(page)); }
  expect(lines[lines.length - 1]!, `down reached the exit (timeline ${lines})`).toBeGreaterThanOrEqual(14);
  for (let i = 1; i < lines.length; i++) {
    expect(lines[i]!, `monotonic down ${lines}`).toBeGreaterThanOrEqual(lines[i - 1]!);
    expect(lines[i]! - lines[i - 1]!, `no whole-cluster jump in one press (${lines})`).toBeLessThanOrEqual(5);
  }
  const up: number[] = [await headLine(page)];
  for (let i = 0; i < 16 && up[up.length - 1]! > 1; i++) { await page.keyboard.press("k"); await sleep(100); up.push(await headLine(page)); }
  expect(up[up.length - 1]!, `k reached the top (${up})`).toBe(1);
  for (let i = 1; i < up.length; i++) {
    expect(up[i]!, `monotonic up ${up}`).toBeLessThanOrEqual(up[i - 1]!);
    expect(up[i - 1]! - up[i]!, `no whole-cluster jump in one press (${up})`).toBeLessThanOrEqual(5);
  }
});

test("#359symptom 2: atoms crossed by a visual selection wear the selection tint", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await vimReady(page, "vim-adjacent-tint-359");
  await page.keyboard.press("V");
  await sleep(80);
  await page.keyboard.press("j"); // extend onto the first atom…
  await sleep(150);
  await page.keyboard.press("j"); // …and past it (the selection now fully covers atom 1)
  await sleep(250);
  const tinted = page.locator("[data-pane=preview] .cm-lp-atom-insel");
  await expect(tinted.first(), "the crossed atom shows the selection tint").toBeVisible({ timeout: 5000 });
  // collapse the selection → the tint clears (display-only, selection-driven)
  await page.keyboard.press("Escape");
  await sleep(300);
  await expect(page.locator("[data-pane=preview] .cm-lp-atom-insel")).toHaveCount(0);
});
