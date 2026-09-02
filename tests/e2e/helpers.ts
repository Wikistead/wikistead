import type { Page } from "@playwright/test";
// @ts-expect-error — repo-root JS helper, no types
import { e2ePorts } from "../../scripts/stack-offset.mjs";
import { memberLabel } from "../../apps/web/src/ui/principal-label"; // #902: the screen's own rule
import { displayNameFor } from "./oidc-issuer"; // #904: the claim that becomes members.display_name
import enLocale from "../../apps/web/src/i18n/locales/en.json" with { type: "json" };
import jaLocale from "../../apps/web/src/i18n/locales/ja.json" with { type: "json" };

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// #484 slice 2: the app origins, derived from WKS_STACK_OFFSET (offset 0 = the original literals).
// Every spec MUST import these instead of hardcoding dev.localhost:4010 / :5180 / :5181 — a hardcoded
// port would hit the wrong (or another session's) stack once isolation is enabled. dev.localhost (not
// localhost) so the server resolves tenant slug "dev".
const P = e2ePorts();
export const API = `http://dev.localhost:${P.server}`; // server REST base (direct, bypasses the web proxy)
export const WEB = `http://dev.localhost:${P.web}`; // dev-token web origin (baseURL)
export const WEB_PORT = P.web; // dev-token web port, for other hosts (e.g. `acme.localhost:${WEB_PORT}`)
export const WEB_REAL_PORT = P.webReal; // real-auth web port, for `${slug}.localhost:${WEB_REAL_PORT}`
// #484 slice 2 left ONE port behind: invite.spec had `http://localhost:8026` inline, so on any
// isolated stack the mail went to that session's Mailpit while the spec queried offset 0's. It read
// as "the invite email never arrived" — a product claim — and the spec was permanently red for every
// session but one. Derived here so there is nowhere left to hardcode it.
export const MAILPIT_API = `http://localhost:${P.mailpit}/api/v1`;
// …and it left a SECOND one, which the sentence above ("nowhere left to hardcode it") missed: eight
// specs write their public-visibility tuple straight at `http://localhost:8090`. That is offset 0's
// OpenFGA. On an isolated stack the tuple lands in ANOTHER session's store — so the page never becomes
// public here, and something over there quietly gains a `user:*` grant it was never asked for. The
// failure reads as "the anonymous reader cannot see a public page", which is a product claim; all
// twelve of `public-page.spec.ts` fail that way, and four more specs with them.
export const FGA = `http://localhost:${P.fgaHttp}`;

/**
 * Delete this spec's leftover OIDC connections before it runs (#623).
 *
 * Connection fixtures used to be cleaned per-id on the success path only, so every failed run left
 * its rows behind — measured at 44 rows of sim589/mcp592 debris, all disabled. That was invisible
 * until the connection cap (ruling ③) made existence itself bounded: at 20 held, every further
 * create answers 409 and the whole family of specs goes red at once. Sweeping AFTER a run can be
 * skipped by a kill; sweeping your own issuers BEFORE the run converges however the last run died.
 */
export async function sweepConnections(issuerPrefixes: string[]): Promise<void> {
  const H = { Authorization: "Bearer dev-token" };
  const res = await fetch(`${API}/admin/connections`, { headers: H });
  if (!res.ok) return; // nothing to sweep on a fresh stack is not a failure
  const rows = (await res.json()) as { id: string; issuer: string }[];
  for (const r of rows) {
    if (issuerPrefixes.some((p) => r.issuer.startsWith(p))) {
      await fetch(`${API}/admin/connections/${r.id}`, { method: "DELETE", headers: H }).catch(() => {});
    }
  }
}

// #354: publish a page and WAIT until its published body actually contains `expectSubstring`. The publish flush
// (collab Valkey req/ack) has a timeout and, under parallel-load, can snapshot a stale/empty ydoc so
// published_md comes out empty — making "type → sleep → publish → assert the view" specs flaky. Polling the
// real published body (re-publishing until it lands) replaces the non-deterministic fixed sleep, so a slow
// flush just costs another poll instead of a false red. Throws if the content never lands within the timeout.
//
// #989: runs as a plain NODE-side fetch against `API`, not inside page.evaluate — a browser-context fetch
// is subject to the app's real (now same-origin-only) CORS policy, and callers of this helper routinely
// invoke it before the page has navigated anywhere (still `about:blank`, an opaque origin CORS always
// refuses regardless of policy). `page` is kept in the signature for call-site compatibility even though
// the fetch itself no longer touches it.
export async function publishAndWait(page: Page, id: string, expectSubstring: string, timeoutMs = 15000): Promise<void> {
  void page;
  const H = { Authorization: "Bearer dev-token" };
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    await fetch(`${API}/pages/${id}/publish`, { method: "POST", headers: H });
    const r = await fetch(`${API}/pages/${id}/published`, { headers: H });
    if (r.ok) {
      last = (((await r.json()) as { publishedMd?: string | null })?.publishedMd) ?? "";
      if (last.includes(expectSubstring)) return;
    }
    await sleep(400);
  }
  throw new Error(`publishAndWait: /published never contained "${expectSubstring}" within ${timeoutMs}ms (last: "${last.slice(0, 80)}")`);
}

export async function openDemo(page: Page) {
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  // #406 S1: below md the docked sidebar is a closed drawer — the toggle is the always-present marker.
  await page.waitForSelector("[data-testid=sidebar], [data-testid=sidebar-toggle]");
  await sleep(800);
}

// Create a REAL throwaway page in demo_space and return its id. Editor specs that need
// an isolated doc (no shared-demo presence ghosts) use this instead of navigating to a
// made-up /p/<id>: a non-existent page is no longer an editable phantom (every page
// belongs to a space — the page#space premise), so tests must edit real pages.
//
// #989: a plain NODE-side fetch (see publishAndWait above for why) — most callers invoke this before
// `page` has navigated anywhere, which a browser-context fetch cannot survive at all now (CORS refuses
// an opaque `about:blank` origin, and a relative URL has no base to resolve against either).
export async function createScratchPage(page: Page, title = "Scratch", spaceId = "demo_space"): Promise<string> {
  void page;
  const r = await fetch(`${API}/spaces/${spaceId}/pages`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return ((await r.json()) as { id: string }).id;
}

/**
 * A space this spec is allowed to mutate.
 *
 * ⚠️ #890 (measured 2026-08-23): a spec that runs a role's assign/unassign loop on `demo_space` takes
 * the seeded `user:dev-user#manager@space:demo_space` grant away and never gives it back. The console
 * enforces "one principal, one role", so assigning REPLACES what the principal already held — the
 * replace-confirm the spec clicks past IS the deletion — and the later unassign leaves nothing. Every
 * spec that renders a space's settings then fails on an empty screen, which reads as a product
 * regression. The fixture reporter added by this ticket named the spec within one test.
 *
 * The house rule the integrity check states is "a spec must not mutate the shared demo fixture — use a
 * scratch resource". This is the space-level form of `createScratchPage`.
 *
 * #989: plain NODE-side fetch — see `createScratchPage`'s comment for why.
 */
export async function createScratchSpace(page: Page, name = "Scratch Space"): Promise<string> {
  void page;
  const r = await fetch(`${API}/spaces`, {
    method: "POST",
    headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return ((await r.json()) as { id: string }).id;
}

// #253 / ADR-113: flip the tenant PARENT SWITCH (tenant_settings.public_enabled) via the admin API. The
// whole anonymous public surface 404s while this is OFF (default), so any spec that expects public rendering
// must turn it ON first. dev-token is a tenant admin in dev mode.
//
// #989: plain NODE-side fetch — see `createScratchPage`'s comment for why.
export async function setPublicSurface(page: Page, enabled: boolean): Promise<void> {
  void page;
  const r = await fetch(`${API}/admin/public-settings`, {
    method: "PUT",
    headers: { Authorization: "Bearer dev-token", "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`public-settings PUT failed: ${r.status}`);
}

// Convenience for single-client editor specs: load the app, create a scratch page, open
// it, and wait for the surface. Returns the page id.
export async function openScratch(page: Page, title = "Scratch"): Promise<string> {
  await page.goto("/p/demo");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  const id = await createScratchPage(page, title);
  await page.goto(`/p/${id}`);
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(400);
  return id;
}

// The editor opens rendered (read-only). Edit reveals the single live-preview surface
// (Step I — split / separate source pane removed). Requires an edit-capable user (the
// dev-token bypass qualifies).
export async function enterEdit(page: Page) {
  await page.click("[data-testid=edit-toggle]");
  await page.waitForSelector("[data-pane=preview] .cm-content");
  await sleep(150);
}
// Back-compat alias: there is no split anymore — entering edit IS the single surface.
export const enterSplit = enterEdit;

export async function resetDoc(page: Page) {
  await page.click("[data-pane=preview] .cm-content");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await sleep(250);
}

export const paneText = (page: Page, pane: "source" | "preview") =>
  page.$eval(`[data-pane=${pane}] .cm-content`, (el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".cm-ySelectionCaret").forEach((n) => n.remove());
    return clone.innerText.replace(/[​⁠]/g, "");
  });

// First character after the remote caret in a pane (display order). Offset-
// invariant: which logical char a collaborator sits before, regardless of which
// markdown syntax this pane hides.
export function charAfterCaret() {
  return (paneSel: string) => {
    const content = document.querySelector(paneSel + " .cm-content");
    if (!content) return { found: false } as { found: boolean; char?: string | null };
    const caret = content.querySelector(".cm-ySelectionCaret");
    if (!caret) return { found: false };
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_ALL);
    let passed = false;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node === caret) { passed = true; continue; }
      if (caret.contains(node)) continue;
      if (passed && node.nodeType === 3) {
        const t = (node.nodeValue ?? "").replace(/[⁠​]/g, "");
        if (t.length) return { found: true, char: t[0] };
      }
    }
    return { found: true, char: null };
  };
}

/**
 * Name the factor that was just enrolled (#653 there is no name field before enrolling).
 *
 * The panel starts every enrolment unnamed, so a row is found by its KIND until somebody names it —
 * and the specs that follow a factor through its life need a name that is theirs alone. The pencil on
 * the row is the only way to give one, which is the point of the ruling: naming is something you do to
 * a thing you have.
 *
 * ⚠️ The newest row is the LAST one: the server orders by `created_at` (`second-factors.ts`). Matching
 * on the kind name instead would grab whichever unnamed row of that kind came first — and these specs
 * share one seeded member, so a neighbour's row is often already sitting there.
 */
export async function nameNewestFactor(page: Page, label: string): Promise<void> {
  const rows = page.locator('[data-testid="factor-row"]');
  // ⚠️ TARGETED BY BEING UNNAMED, not by position. Two earlier versions failed in batches, and both
  // failures were the same mistake in different clothes: `.last()` re-resolved between steps, and then
  // an index taken BEFORE the new row had landed pointed at a NEIGHBOUR's row — these specs share one
  // seeded member, so the name went onto somebody else's factor and the caller then followed the wrong
  // row (measured: a passkey walk ended up asserting against a TOTP row's remove-code box).
  //
  // A row wears `factor-kind-mark` only once it HAS a name, so the row just enrolled is the last one
  // without it. Waiting for that is also waiting for the list to have refreshed, which is the thing
  // the index version silently skipped.
  const unnamed = rows.filter({ hasNot: page.getByTestId("factor-kind-mark") });
  await unnamed.last().waitFor({ state: "visible", timeout: 20_000 });
  await unnamed.last().getByTestId("factor-rename").click();
  // The panel keeps exactly one row in rename mode, so the open editor is an unambiguous handle that
  // does not shift when another row arrives mid-edit.
  const editing = rows.filter({ has: page.getByTestId("factor-rename-input") });
  await editing.getByTestId("factor-rename-input").waitFor({ state: "visible", timeout: 15_000 });
  await editing.getByTestId("factor-rename-input").fill(label);
  await editing.getByTestId("factor-rename-save").click();
  // Wait for the row to carry the name, not merely for the click: the save is a request, and the next
  // step in every caller looks the row up BY that name.
  await page.locator('[data-testid="factor-row"]', { hasText: label }).first().waitFor({ timeout: 15_000 });
}

/**
 * #623 / ADR-220 §6.2: `GET /spaces/:id/pages` answers `{ pages, truncated }` — the guest tree's cap
 * is a visible state, not a silent cut, so the list had to grow a sibling field. Callers written
 * before that read the body as a bare array; the shape change turned four of them into `undefined`
 * lengths and `.filter is not a function`, and they stayed red for two weeks because nothing runs
 * the e2e suite on the way to master.
 *
 * Reading through this instead of at each call site keeps the knowledge of the shape in ONE place —
 * the next field the route grows is a change here, not a hunt through the specs.
 */
export function pageList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  return ((body as { pages?: T[] } | null)?.pages) ?? [];
}

// #902: what the screen actually shows for a person. ⚠️ Imported from the shipped renderer rather
// than restated here: five specs asserted the raw subject, which stopped appearing the day
// `memberLabel` started preferring the display name (#859). A rule copied into the harness would have
// drifted again the next time the screen's changed -- so the harness asks the screen's own function.
//
// ⚠️ And do NOT inline the seeded name instead. `Dev User` is a seed value; a spec spelling it out is
// green until somebody edits `infra/db/seed.ts`, and then five specs fail for a reason that has
// nothing to do with what they test.
export function shownAs(sub: string, displayName: string | null): string {
  // The noun comes from the shipped catalogue too — `memberLabel` takes it as an argument precisely so
  // it stays a pure function, and a harness that hard-codes "unknown member" is one more copy to drift.
  return memberLabel(sub, displayName, enLocale.spaceMembers.unknownMember);
}

// What the screen shows for the seeded admin. The display name comes from the ISSUER's `name` claim,
// not from the seed: the login upsert overwrites `members.display_name` with the claim on every
// sign-in (session.ts), so the seed's value only survives until the first login. Asking the issuer's
// own derivation is therefore asking the thing that actually decides.
//
// ⚠️ This is deliberately NOT `shownAs("dev-user", "dev-user")`, which is what the running system
// produced before #904. That version passes while asserting nothing: the no-name fallback is
// `shortPrincipalId(sub)`, and shortening `dev-user` returns `dev-user`, so the display-name path and
// the subject path collapse to one string and the pin survives deleting `memberLabel` outright.
export const DEV_USER_SHOWN = shownAs("dev-user", displayNameFor("dev-user"));

// #891: the invite-by-email field's accessible name, asked from the shipped copy (not a spec's own
// guess) for the same reason as DEV_USER_SHOWN above — four specs (admin-gate, avatar-isolation-372,
// invite-handoff-638, one-secret-title-646) each hard-coded a guessed EN/JA pair that was never the
// shipped `members.inviteEmail` string in either locale — spec rot that a copy change can't surface,
// since none of these specs run in any CI gate today (#891).
export const INVITE_EMAIL_LABEL = new RegExp(`^(${enLocale.members.inviteEmail}|${jaLocale.members.inviteEmail})$`);
