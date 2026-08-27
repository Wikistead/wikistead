import postgres from "postgres";
import { readFileSync } from "node:fs";
// @ts-expect-error — repo-root JS helper, no types
import { e2ePorts } from "../../scripts/stack-offset.mjs";

// #484 slice 2: this stack's ports (offset 0 = the original literals).
const P = e2ePorts();

// #279: the shared demo fixture's FGA tuples (esp. `space:demo_space#space@page:demo`) are seeded once by
// `fga:seed` at stack init, NOT re-asserted per run — so if a spec deletes one, every later run stays broken
// (page:demo view=false → share.spec / guest-sidebar-245 fail). seedFgaFixtures() re-writes the core demo/
// acme hierarchy tuples idempotently on every globalSetup, so the next run always self-heals; the
// globalTeardown integrity check (assertDemoFixtureIntact) fails a run that leaves the fixture broken, so the
// culprit spec is caught red-handed. We talk to OpenFGA over its plain HTTP API (like Meili above) to avoid
// adding @openfga/sdk as an e2e dependency. The store/model ids are dynamic → read from the e2e env files
// (globalSetup isn't launched with --env-file, so parse them ourselves; .env.e2e.local overrides .env.e2e).

// The core shared-fixture tuples — the demo + acme hierarchy from infra/openfga/seed.ts (the conditioned,
// per-spec-managed share links are intentionally excluded; specs own those).
const CORE_FGA_TUPLES = [
  { user: "user:dev-user", relation: "admin", object: "tenant:tenant_dev" },
  { user: "user:dev-user", relation: "member", object: "tenant:tenant_dev" },
  { user: "tenant:tenant_dev", relation: "tenant", object: "space:demo_space" },
  { user: "user:dev-user", relation: "manager", object: "space:demo_space" },
  { user: "space:demo_space", relation: "space", object: "page:demo" },
  // ⚠️ #890: this said `view_base` until 2026-08-22, and `view_base` takes only `[user:*]` in the model
  // (#218 moved link grants to the `view_direct` leaf). The write was therefore REJECTED on every
  // globalSetup and swallowed by the best-effort catch below, so the anchor was permanently absent —
  // it showed up in the first widened integrity report as "deleted during this run", which it never was.
  { user: "share_link:demo_view_perm", relation: "view_direct", object: "page:demo" },
  // #471 / ADR-176: a request principal must be a member of the tenant it is used against, so every
  // subject the specs speak as needs real membership — `admin` alone describes a tenant nobody can
  // authenticate into (admin and member are separate relations; provisioning writes both).
  { user: "user:stranger", relation: "member", object: "tenant:tenant_dev" },
  { user: "user:acme-admin", relation: "admin", object: "tenant:tenant_acme" },
  { user: "user:acme-admin", relation: "member", object: "tenant:tenant_acme" },
  { user: "tenant:tenant_acme", relation: "tenant", object: "space:acme_space" },
  { user: "user:acme-admin", relation: "manager", object: "space:acme_space" },
  { user: "space:acme_space", relation: "space", object: "page:acme_page" },
] as const;

function fgaEnv(): { apiUrl: string; storeId: string; modelId: string } {
  const parse = (rel: string): Record<string, string> => {
    try {
      const text = readFileSync(new URL(rel, import.meta.url), "utf8");
      const out: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#") || !t.includes("=")) continue;
        const i = t.indexOf("=");
        out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
      }
      return out;
    } catch {
      return {};
    }
  };
  const env = { ...parse("../../.env.e2e"), ...parse("../../.env.e2e.local") };
  return {
    apiUrl: env.OPENFGA_API_URL ?? "http://localhost:8081",
    storeId: env.OPENFGA_STORE_ID ?? "",
    modelId: env.OPENFGA_MODEL_ID ?? "",
  };
}

async function fga(path: string, body: unknown, apiUrl: string, storeId: string) {
  return fetch(`${apiUrl}/stores/${storeId}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// #444: DENY-marker residues on the SHARED fixture objects. A trash/private spec that dies mid-run
// (kill/timeout) leaves its markers behind, and because markers are deny-side, re-asserting the CORE
// grants does NOT heal them — page:demo goes byte-invisible for every later run (twice on 2026-07-17).
// The seed now strips every known marker pair from the shared objects before re-asserting the grants.
// Exported so the #444 pin can loop over the SAME definition: shrink either list and the pin shrinks
// with it, which is the whole point (the first pin hard-coded one relation and would have stayed green
// through any narrowing).
export const FIXTURE_OBJECTS = ["page:demo", "space:demo_space", "page:acme_page", "space:acme_space"] as const;
// Every relation that a spec can WRITE as a typed wildcard, i.e. every marker a killed spec can strand
// on a shared object: private (model.fga [user:*, share_link:*]), trashed (same), frozen (same) and
// frozen_guests ([share_link:*]). frozen is structurally identical to the two that caused the outage —
// no spec freezes a shared fixture today, so it is latent rather than broken, which is exactly when it
// is cheap to close. `restricted` is deliberately NOT here: it takes concrete principals
// ([user, group#member, share_link]), never a wildcard, so it cannot produce this residue class.
export const DENY_MARKER_RELATIONS = ["trashed", "private", "frozen", "frozen_guests"] as const;
// frozen_guests only accepts share_link:*; the user:* delete for it fails on type and is swallowed
// with every other absent-tuple delete below (the loop is a total sweep, not a precise one).
export const DENY_MARKER_USERS = ["user:*", "share_link:*"] as const;

// Idempotently (re-)assert the core shared-fixture tuples. delete-then-write per tuple: OpenFGA rejects
// writing a tuple that already exists AND deleting one that doesn't, so each op is tried and its error
// swallowed — the end state is exactly the CORE set present (and NO deny markers on shared objects).
export async function seedFgaFixtures(): Promise<void> {
  const { apiUrl, storeId, modelId } = fgaEnv();
  if (!storeId) return; // no e2e FGA configured (unit-only run) — nothing to seed
  for (const object of FIXTURE_OBJECTS) {
    for (const relation of DENY_MARKER_RELATIONS) {
      for (const user of DENY_MARKER_USERS) {
        try { await fga("/write", { deletes: { tuple_keys: [{ user, relation, object }] } }, apiUrl, storeId); } catch { /* absent */ }
      }
    }
  }
  for (const t of CORE_FGA_TUPLES) {
    const key = { user: t.user, relation: t.relation, object: t.object };
    try { await fga("/write", { deletes: { tuple_keys: [key] } }, apiUrl, storeId); } catch { /* absent */ }
    // #890: the write used to be best-effort too, and that is how a stale anchor survived for months —
    // a tuple the model refuses is refused on every run, silently, and the only symptom is an integrity
    // report blaming a spec for a deletion that never happened. Self-healing that cannot heal has to say so.
    const written = await fga("/write", { writes: { tuple_keys: [key] }, authorization_model_id: modelId }, apiUrl, storeId)
      .catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) } as unknown as Response));
    if (!written.ok) {
      throw new Error(
        `#890 fixture seed: OpenFGA refused \`${key.user}#${key.relation}@${key.object}\` (${written.status}). ` +
          `The anchor and the model disagree — fix CORE_FGA_TUPLES or the model, do not ignore this. ` +
          (await written.text().catch(() => "")),
      );
    }
  }
}

// #279 integrity check: fail the run if the shared fixture didn't survive, so the spec that broke it
// is caught in that run rather than silently breaking the NEXT one.
//
// ⚠️ #890: this used to read ONE of the twelve tuples above. A run that lost only
// `user:dev-user#manager@space:demo_space` therefore passed the check while every space-settings spec
// failed with an empty screen — the tab strip is built from what that tuple grants, so the reds read
// as a product regression and not as a broken fixture. Measured on 2026-08-22: `space:demo_space` and
// `page:demo` were both down to ZERO tuples mid-run while `space:acme_space` still had its two.
/**
 * What the integrity check found: anchors that are really gone, or a reason it could not tell.
 *
 * ⚠️ Three-valued on purpose (#890, measured 2026-08-23). This used to return only the missing list,
 * decided by `json.tuples` being empty — so an ERROR RESPONSE looked exactly like an absent tuple. When
 * the store wedged mid-run (`deadline_exceeded` on every read, Postgres beside it perfectly healthy),
 * the check reported all twelve anchors as deleted and the reporter named the spec that happened to
 * finish first. That spec touched none of them; restarting OpenFGA brought all twelve back, so nothing
 * had ever been deleted. Blaming an innocent spec with confidence is worse than the wall of reds this
 * instrumentation was built to replace.
 *
 * `seedFgaFixtures` already draws this line on the WRITE side ("self-healing that cannot heal has to
 * say so"). This is the same line on the read side; it was missing because only one side was counted.
 */
/**
 * One anchor's verdict, decided from what the store actually answered.
 *
 * ⚠️ Pulled out as a pure function so it can be RUN by a pin. The defect this exists to remove lives in
 * the classification itself, and a pin that reads the source for a string cannot see whether the branch
 * it is reading is reachable — the previous version's fatal branch was reachable and wrong.
 */
export type AnchorVerdict = { kind: "present" } | { kind: "missing" } | { kind: "unreadable"; why: string };

export function classifyAnchorRead(res: { ok: boolean; status: number } | null, body: unknown, error?: unknown): AnchorVerdict {
  if (res === null) return { kind: "unreadable", why: `the request never arrived (${String(error)})` };
  if (!res.ok) return { kind: "unreadable", why: `${res.status} ${typeof body === "string" ? body : ""}`.trim() };
  if (body === undefined) return { kind: "unreadable", why: "200 with an unreadable body" };
  const tuples = (body as { tuples?: unknown }).tuples;
  // A 200 whose shape nobody promised is not an absence. The old code read `!json.tuples` as "gone",
  // which is how an error body — `{}` after a failed `.json()` — became a deletion report.
  if (!Array.isArray(tuples)) return { kind: "unreadable", why: "200 without a tuples array" };
  return tuples.length === 0 ? { kind: "missing" } : { kind: "present" };
}

export interface FixtureIntegrity {
  /** Anchors the store answered for, and does not have. */
  missing: string[];
  /** Why the store could not be asked. Non-empty means the `missing` list decides nothing. */
  unreadable: string[];
}

export async function coreFixtureIntegrity(): Promise<FixtureIntegrity> {
  const { apiUrl, storeId } = fgaEnv();
  if (!storeId) return { missing: [], unreadable: [] };
  const missing: string[] = [];
  const unreadable: string[] = [];
  for (const t of CORE_FGA_TUPLES) {
    const name = `${t.user}#${t.relation}@${t.object}`;
    let res: Response | null = null;
    let body: unknown;
    let error: unknown;
    try {
      res = await fga("/read", { tuple_key: t }, apiUrl, storeId);
      // The store answering "I cannot" is not the store answering "it is not here", so the failure
      // body is read as text and the success body as JSON — and a body that will not parse is its own
      // answer rather than an empty object standing in for one.
      body = res.ok ? await res.json().catch(() => undefined) : await res.text().catch(() => "");
    } catch (e) {
      error = e;
      res = null;
    }
    const verdict = classifyAnchorRead(res, body, error);
    if (verdict.kind === "missing") missing.push(name);
    else if (verdict.kind === "unreadable") unreadable.push(`${name}: ${verdict.why}`);
  }
  return { missing, unreadable };
}

/**
 * Back-compat shim: the missing list alone.
 *
 * ⚠️ Callers that decide whether to BLAME somebody must use `coreFixtureIntegrity` and check
 * `unreadable` first — this shape cannot tell them the difference.
 */
export async function missingCoreFixtureTuples(): Promise<string[]> {
  return (await coreFixtureIntegrity()).missing;
}

export async function assertDemoFixtureIntact(): Promise<void> {
  const { missing, unreadable } = await coreFixtureIntegrity();
  // ⚠️ "I could not ask" fails too, and says so in its own words. Passing on an unreadable store would
  // make the teardown report "the fixture is fine" about a store it never reached.
  if (unreadable.length > 0) {
    throw new Error(
      `#890 fixture integrity: the store could not be asked about ${unreadable.length} of ` +
        `${CORE_FGA_TUPLES.length} anchors, so this run proves NOTHING about the fixture:\n  ` +
        unreadable.join("\n  ") +
        "\nCheck the store itself (`/healthz`, its own logs) before suspecting any spec. " +
        "Measured 2026-08-23: OpenFGA wedged at its 3 s deadline with Postgres healthy beside it, and " +
        "a restart brought every anchor back — nothing had been deleted.",
    );
  }
  if (missing.length > 0) {
    throw new Error(
      `#279/#890 fixture integrity: ${missing.length} of ${CORE_FGA_TUPLES.length} shared tuples were DELETED ` +
        `during this run:\n  ${missing.join("\n  ")}\n` +
        "A spec must not mutate the shared demo fixture — use a scratch resource + afterAll cleanup. " +
        "seedFgaFixtures() will self-heal the next run, but fix the offending spec. " +
        "The per-file reporter (fixture-guard-reporter.ts) names it if the run reached that far.",
    );
  }
}

// Coordinates of the ISOLATED e2e middleware (docker-compose.e2e.yml). Fixed by
// that compose file, so the harness can hardcode them.
export const E2E = {
  pgAdmin: `postgres://postgres:postgres@localhost:${P.pg}/app`,
  meili: `http://localhost:${P.meili}`,
  meiliKey: "dev_master_key_change_me",
  tenant: "tenant_dev",
  index: "pages",
};

// Security fixtures that prove the two-stage guards from the UI:
//   - LOCKED space/page: present in Postgres (RLS returns it) but with NO FGA
//     grant, so listSpaces must exclude it -> tree.spec asserts it's not shown.
//   - STALE Meili doc: a denormalized viewer (user:dev-user) with NO FGA grant,
//     so it IS a stage-1 candidate but the API's stage-2 FGA check drops it ->
//     search.spec asserts it's not shown.
export const LOCKED_SPACE_NAME = "E2E LOCKED SPACE";
export const LOCKED_SPACE_ID = "e2e-locked-space";
export const LOCKED_PAGE_ID = "e2e-locked-page";
export const STALE_TITLE = "E2ESTALEONLYTITLE";
const STALE_ID = "e2e-stale-doc";

async function meili(path: string, init: RequestInit = {}) {
  const res = await fetch(`${E2E.meili}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${E2E.meiliKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return res;
}

export async function seedFixtures() {
  // --- locked space + page (admin pool bypasses RLS for the insert) ---
  const sql = postgres(E2E.pgAdmin);
  try {
    // Clean baseline so specs are idempotent across runs: the e2e DB persists
    // between runs and tests create/move/delete pages, so we fully wipe the
    // tenant and re-create the canonical seed (demo_space/demo — matching the
    // fixed ids that fga:seed grants) plus the locked fixtures. Wiping pages
    // cascades their attachments/revisions (composite FK ON DELETE CASCADE).
    await sql`DELETE FROM pages WHERE tenant_id = ${E2E.tenant}`;
    await sql`DELETE FROM spaces WHERE tenant_id = ${E2E.tenant}`;
    await sql`INSERT INTO spaces (id, tenant_id, name) VALUES ('demo_space', ${E2E.tenant}, 'Demo Space')`;
    await sql`INSERT INTO pages (id, tenant_id, space_id, title) VALUES ('demo', ${E2E.tenant}, 'demo_space', 'Demo Page')`;
    // #940: this predates ADR-157's home-page pointer (#364) — the space above never registered its
    // page as home, so HomeLanding's own documented fallback for a home-less space (land on
    // `/spaces/<id>` instead of a page) fired for the product's most-used fixture. That fallback is
    // correct; the fixture was incomplete — measured landing at /spaces/demo_space instead of /p/demo
    // after any flow that revisits "/" (e.g. a space delete's post-action redirect).
    await sql`UPDATE spaces SET home_page_id = 'demo' WHERE tenant_id = ${E2E.tenant} AND id = 'demo_space'`;

    // Locked fixtures: present in Postgres (RLS returns them) but with NO FGA
    // grant, so dev-user can neither view nor edit them.
    await sql`INSERT INTO spaces (id, tenant_id, name) VALUES (${LOCKED_SPACE_ID}, ${E2E.tenant}, ${LOCKED_SPACE_NAME})`;
    await sql`INSERT INTO pages (id, tenant_id, space_id, title) VALUES (${LOCKED_PAGE_ID}, ${E2E.tenant}, ${LOCKED_SPACE_ID}, 'locked page')`;

    // #603 / #621: dev-user CARRIES a group, and this is the third time it had to be restored by hand.
    // The dev seed (`infra/db/seed.ts`) says why it matters — the completion list, the hash→name reverse
    // lookup and the group-conferred roles all read `members.groups`, so an empty directory makes those
    // specs measure the empty case and report nothing. But that seed only runs against the DEV database;
    // nothing re-established it here, and a real OIDC sign-in overwrites the column from its claims (the
    // drift observed on 2026-08-04 and twice since). Seeding it per run makes the fixture self-healing
    // like the FGA one beside it, instead of a state somebody has to notice has gone missing.
    await sql`UPDATE members SET groups = ARRAY['wiki Editors']
              WHERE tenant_id = ${E2E.tenant} AND sub = 'dev-user'`;
  } finally {
    await sql.end();
  }

  // --- ensure Meili index + filterable attrs, then add the stale doc ---
  await meili(`/indexes`, { method: "POST", body: JSON.stringify({ uid: E2E.index, primaryKey: "id" }) });
  await meili(`/indexes/${E2E.index}/settings/filterable-attributes`, {
    method: "PUT",
    body: JSON.stringify(["tenantId", "spaceId", "viewerUsers", "viewerGroups", "isPublic"]),
  });
  // Wipe ALL Meili docs to match the Postgres wipe above — the e2e Meili persists
  // between runs, and specs that index a fixed-body doc (e.g. cjk-search) would
  // otherwise pile up identical docs across runs. Once enough accumulate, the
  // stage-1 limit window fills with orphaned cruft whose FGA grants are gone, so
  // the two-stage guard drops them all and the current run's hit is crowded out
  // (→ "No results"). Clearing here keeps search specs idempotent. Wait on the
  // task so the re-added stale doc below isn't deleted by a late-running clear.
  {
    const r = await meili(`/indexes/${E2E.index}/documents`, { method: "DELETE" });
    const { taskUid } = await r.json();
    if (typeof taskUid === "number") {
      for (let i = 0; i < 60; i++) {
        const t = await (await meili(`/tasks/${taskUid}`)).json();
        if (t.status === "succeeded" || t.status === "failed" || t.status === "canceled") break;
        await new Promise((res) => setTimeout(res, 250));
      }
    }
  }
  await meili(`/indexes/${E2E.index}/documents`, {
    method: "POST",
    body: JSON.stringify([
      {
        id: STALE_ID,
        tenantId: E2E.tenant,
        spaceId: "demo_space",
        title: STALE_TITLE,
        body: "",
        viewerUsers: ["user:dev-user"],
        viewerGroups: [],
        isPublic: false,
        updatedAt: 1,
      },
    ]),
  });
  // Give Meili a moment to process the (async) document + settings tasks.
  await new Promise((r) => setTimeout(r, 1500));
}
