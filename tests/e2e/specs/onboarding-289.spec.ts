import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { openDemo, enterEdit, sleep } from "../helpers";

// #289 / ADR-115: editor persona onboarding + per-user chrome visibility, in a real browser.
// The first-run gate fires on `onboarding_completed_at IS NULL`; the dev member is backfilled
// completed by migration 058, so each test arms the gate by nulling the column directly (the same
// admin-DB access fixtures.ts uses), and afterEach RESTORES the shared member's state so the other
// specs are untouched (the dev-token member is a shared fixture).
const API = "http://dev.localhost:4010";
const PG = "postgres://postgres:postgres@localhost:5433/app";
const SUB = "dev-user";

const sql = postgres(PG, { max: 1 });

const armFirstRun = () => sql`UPDATE members SET onboarding_completed_at = NULL, editor_chrome = NULL WHERE sub = ${SUB} AND tenant_id = 'tenant_dev'`;
const restore = () => sql`UPDATE members SET onboarding_completed_at = now(), editor_chrome = NULL, editor_display_mode = NULL, editor_keymap = NULL WHERE sub = ${SUB} AND tenant_id = 'tenant_dev'`;

const mySettings = (p: Page) =>
  p.evaluate(async ({ api }) => {
    const r = await fetch(`${api}/me/settings`, { headers: { Authorization: "Bearer dev-token" } });
    return (await r.json()) as { editorChrome: { vimToggleVisible: boolean; modesVisible: Record<string, boolean> } | null; editorDisplayMode: string; editorKeymap: string; onboardingCompletedAt: string | null };
  }, { api: API });

test.afterEach(async () => { await restore(); });
test.afterAll(async () => { await sql.end(); });

test("#289 first run: vim answer applies the vim preset and the dialog never re-fires", async ({ browser }) => {
  await armFirstRun();
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);

  const dialog = page.getByTestId("onboarding-dialog");
  await expect(dialog).toBeVisible({ timeout: 8000 });
  await page.getByTestId("onboarding-q1-yes").click(); // vim persona (Q2 skipped)
  await expect(page.getByTestId("onboarding-done")).toBeVisible();
  await page.getByTestId("onboarding-close").click();
  await expect(dialog).toHaveCount(0);
  await sleep(600); // let the PATCH settle

  const s = await mySettings(page);
  expect(s.editorChrome).toEqual({ vimToggleVisible: true, modesVisible: { live: true, source: true, reading: true, wysiwyg: false } });
  expect(s.editorDisplayMode).toBe("live");
  expect(s.editorKeymap).toBe("vim"); // "shown, ON"
  expect(s.onboardingCompletedAt).not.toBeNull();

  // chrome takes effect: vim button visible, WYSIWYG gone from the segment AND the cycle
  await enterEdit(page);
  await expect(page.getByTestId("vim-toggle")).toBeVisible();
  await expect(page.getByTestId("displaymode-wysiwyg")).toHaveCount(0);
  await expect(page.getByTestId("displaymode-live")).toBeVisible();

  // reload → completed marker holds, no dialog
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(600);
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
});

test("#289 skip keeps the FULL chrome and only marks seen", async ({ browser }) => {
  await armFirstRun();
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("onboarding-skip").click();
  await expect(page.getByTestId("onboarding-dialog")).toHaveCount(0);
  await sleep(600); // let the PATCH settle

  const s = await mySettings(page);
  expect(s.editorChrome).toBeNull(); // untouched (ruling #4)
  expect(s.onboardingCompletedAt).not.toBeNull();

  await enterEdit(page);
  await expect(page.getByTestId("vim-toggle")).toBeVisible();
  for (const m of ["live", "source", "reading", "wysiwyg"]) {
    await expect(page.getByTestId(`displaymode-${m}`)).toBeVisible();
  }
});

test("#289 wysiwyg persona: hidden modes leave the segment AND the cycle; startup mode is wysiwyg", async ({ browser }) => {
  await armFirstRun();
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("onboarding-q1-no").click();
  await page.getByTestId("onboarding-q2-no").click(); // wysiwyg persona
  await expect(page.getByTestId("onboarding-done")).toBeVisible();
  await page.getByTestId("onboarding-close").click();
  await sleep(600); // let the PATCH settle

  const s = await mySettings(page);
  expect(s.editorChrome).toEqual({ vimToggleVisible: false, modesVisible: { live: false, source: false, reading: true, wysiwyg: true } });
  expect(s.editorDisplayMode).toBe("wysiwyg");

  // fresh load → boots in WYSIWYG; vim button hidden; segment offers only wysiwyg + reading
  await page.reload();
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await enterEdit(page);
  await expect(page.getByTestId("vim-toggle")).toHaveCount(0);
  await expect(page.getByTestId("displaymode-live")).toHaveCount(0);
  await expect(page.getByTestId("displaymode-source")).toHaveCount(0);
  const segment = page.getByTestId("displaymode-segment");
  await expect(segment).toHaveAttribute("data-mode", "wysiwyg");

  // the Ctrl+Alt+E cycle skips the hidden live/source: wysiwyg → reading → wysiwyg
  await page.keyboard.press("Control+Alt+e");
  await expect(segment).toHaveAttribute("data-mode", "reading");
  await page.keyboard.press("Control+Alt+e");
  await expect(segment).toHaveAttribute("data-mode", "wysiwyg");

  // no dead-end: Ctrl+Alt+V still toggles vim even with the button hidden (ADR-115 §3)
  await page.keyboard.press("Control+Alt+v");
  await sleep(200); // no crash / mode intact — vim state itself is asserted by the keymap suite
});

test("#289 settings: chrome toggles + startup wysiwyg option + redo entry", async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await openDemo(page);
  await page.goto("/settings/account/editor");
  await expect(page.getByTestId("account-chrome")).toBeVisible({ timeout: 8000 });

  // hide the vim button via the toggle → persisted
  await page.getByTestId("account-chrome-vim").click();
  await expect.poll(async () => (await mySettings(page)).editorChrome?.vimToggleVisible).toBe(false);
  // hide a mode → persisted; the LAST visible mode cannot be hidden. (Settle between clicks —
  // the card writes the whole visibility object from the last-loaded settings.)
  await page.getByTestId("account-chrome-mode-source").click();
  await expect.poll(async () => (await mySettings(page)).editorChrome?.modesVisible.source).toBe(false);
  await page.getByTestId("account-chrome-mode-live").click();
  await expect.poll(async () => (await mySettings(page)).editorChrome?.modesVisible.live).toBe(false);
  await page.getByTestId("account-chrome-mode-reading").click();
  await expect.poll(async () => (await mySettings(page)).editorChrome?.modesVisible.reading).toBe(false);
  await sleep(400);
  await page.getByTestId("account-chrome-mode-wysiwyg").click(); // would leave zero → ignored
  await sleep(600);
  await expect.poll(async () => (await mySettings(page)).editorChrome?.modesVisible.wysiwyg).toBe(true);

  // the startup selector now offers WYSIWYG (catalog widened) and persists it
  await page.getByTestId("account-displaymode-wysiwyg").click();
  await expect.poll(async () => (await mySettings(page)).editorDisplayMode).toBe("wysiwyg");

  // redo entry reopens the two-question flow
  await page.getByTestId("account-chrome-redo").click();
  await expect(page.getByTestId("onboarding-dialog")).toBeVisible();
  await expect(page.getByTestId("onboarding-q1")).toBeVisible();
});
