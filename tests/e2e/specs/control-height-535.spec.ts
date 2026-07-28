import { test, expect } from "@playwright/test";

// #535: controls that sit on the same line share a height.
//
// This pin used to name two rows. It passed on one and could not even FIND the other — the space role
// assignment section only renders when the tenant has custom roles, so that half had quietly stopped
// measuring anything — while SEVEN rows across the settings screens were ragged, including one #536 added
// three minutes after the previous round was reviewed. Naming rows means the next row anyone writes is
// unpinned by construction, and a named row that stops rendering pins nothing at all.
//
// So it no longer names any. It walks every settings route, DISCOVERS the rows from the rendered page, and
// checks each one it finds. A new screen is covered the day it is added.
//
// A "row" is found the way a reader finds one: visible controls whose vertical extents overlap, that are
// horizontally adjacent. Two controls that merely happen to align across a wide gap are not a row, so the
// grouping splits where the horizontal gap exceeds ROW_GAP_PX.
const ADMIN = ["analytics", "api", "audit", "auth", "billing", "branding", "embeds", "members",
  "moderation", "orphan-drafts", "public", "roles", "spaces", "webhooks"];
const SPACE = ["analytics", "general", "members", "moderation", "pages", "trash"];
const ACCOUNT = ["", "api-keys", "data", "editor", "notifications", "theme"];

const ROW_GAP_PX = 48;

// Runs in the page. Returns one entry per discovered row whose controls disagree on height.
const RAGGED = `((gapPx) => {
  const root = document.querySelector("main") || document.body;
  const CONTROLS = "button, [data-slot=select-trigger], input:not([type=hidden]), select, textarea";
  const seen = [...root.querySelectorAll(CONTROLS)]
    .filter((e) => e.offsetParent !== null && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().width > 0)
    .map((e) => {
      const r = e.getBoundingClientRect();
      const cls = typeof e.className === "string" ? e.className : (e.className && e.className.baseVal) || "";
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: Math.round(r.height),
        label: (e.getAttribute("data-testid") || e.getAttribute("aria-label") || e.tagName.toLowerCase()) + " (" + cls.split(" ")[0] + ")" };
    });

  // union-find over "shares a visual line": vertical overlap of at least 60% of the shorter control
  const parent = seen.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < seen.length; i++) {
    for (let j = i + 1; j < seen.length; j++) {
      const a = seen[i], b = seen[j];
      const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlap >= 0.6 * Math.min(a.bottom - a.top, b.bottom - b.top)) parent[find(i)] = find(j);
    }
  }
  const lines = new Map();
  seen.forEach((c, i) => { const k = find(i); if (!lines.has(k)) lines.set(k, []); lines.get(k).push(c) });

  const ragged = [];
  for (const line of lines.values()) {
    line.sort((a, b) => a.left - b.left);
    let run = [line[0]];
    const check = () => {
      if (run.length < 2) return;
      const hs = run.map((c) => c.h);
      if (Math.max(...hs) - Math.min(...hs) > 1) ragged.push(run.map((c) => c.label + " h=" + c.h).join(" | "));
    };
    for (let i = 1; i < line.length; i++) {
      if (line[i].left - run[run.length - 1].right > gapPx) { check(); run = [line[i]] } else run.push(line[i]);
    }
    check();
  }
  return ragged;
})(${ROW_GAP_PX})`;

const SUITES: { name: string; urls: string[] }[] = [
  { name: "the admin console", urls: ADMIN.map((s) => `/admin/${s}`) },
  { name: "space settings", urls: SPACE.map((s) => `/spaces/demo_space/settings/${s}`) },
  { name: "account settings", urls: ACCOUNT.map((s) => `/settings/account/${s}`) },
];

for (const { name, urls } of SUITES) {
  test(`#535: every form row in ${name} is on one scale`, async ({ page }) => {
    const problems: string[] = [];
    let controlsSeen = 0;
    for (const url of urls) {
      await page.goto(url);
      // Nothing here waits on a specific testid: the point is to look at whatever the page ended up
      // drawing, so that a screen nobody thought to name is still measured.
      await page.waitForTimeout(1500);
      const found = (await page.evaluate(RAGGED)) as string[];
      controlsSeen += (await page.evaluate(`document.querySelectorAll("main button, main input").length`)) as number;
      for (const row of found) problems.push(`${url}\n      ${row}`);
    }
    // Guard against a vacuous pass: a page that rendered nothing has no ragged rows either.
    expect(controlsSeen, "the pages rendered controls at all").toBeGreaterThan(urls.length);
    expect(problems, `ragged rows:\n  ${problems.join("\n  ")}`).toHaveLength(0);
  });
}
