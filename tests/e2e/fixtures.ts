import postgres from "postgres";
import { readFileSync } from "node:fs";

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
  { user: "share_link:demo_view_perm", relation: "view_base", object: "page:demo" },
  { user: "user:acme-admin", relation: "admin", object: "tenant:tenant_acme" },
  { user: "tenant:tenant_acme", relation: "tenant", object: "space:acme_space" },
  { user: "user:acme-admin", relation: "manager", object: "space:acme_space" },
  { user: "space:acme_space", relation: "space", object: "page:acme_page" },
] as const;
// The one tuple whose loss caused #279 — the teardown integrity check asserts it survives the run.
const DEMO_PAGE_TUPLE = { user: "space:demo_space", relation: "space", object: "page:demo" };

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
const FIXTURE_OBJECTS = ["page:demo", "space:demo_space", "page:acme_page", "space:acme_space"] as const;
const DENY_MARKER_RELATIONS = ["trashed", "private"] as const; // model.fga: [user:*, share_link:*] pairs
const DENY_MARKER_USERS = ["user:*", "share_link:*"] as const;

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
    try {
      await fga("/write", { writes: { tuple_keys: [key] }, authorization_model_id: modelId }, apiUrl, storeId);
    } catch { /* best effort */ }
  }
}

// #279 integrity check (globalTeardown): fail the run if the demo page tuple didn't survive, so the spec
// that deleted it is caught in that run rather than silently breaking the NEXT one.
export async function assertDemoFixtureIntact(): Promise<void> {
  const { apiUrl, storeId } = fgaEnv();
  if (!storeId) return;
  const res = await fga("/read", { tuple_key: DEMO_PAGE_TUPLE }, apiUrl, storeId);
  const json = (await res.json().catch(() => ({}))) as { tuples?: unknown[] };
  if (!json.tuples || json.tuples.length === 0) {
    throw new Error(
      "#279 fixture integrity: the shared `space:demo_space#space@page:demo` tuple was DELETED during this run. " +
        "A spec must not mutate the shared demo fixture — use a scratch resource + afterAll cleanup. " +
        "seedFgaFixtures() will self-heal the next run, but fix the offending spec.",
    );
  }
}

// Coordinates of the ISOLATED e2e middleware (docker-compose.e2e.yml). Fixed by
// that compose file, so the harness can hardcode them.
export const E2E = {
  pgAdmin: "postgres://postgres:postgres@localhost:5433/app",
  meili: "http://localhost:7701",
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

    // Locked fixtures: present in Postgres (RLS returns them) but with NO FGA
    // grant, so dev-user can neither view nor edit them.
    await sql`INSERT INTO spaces (id, tenant_id, name) VALUES (${LOCKED_SPACE_ID}, ${E2E.tenant}, ${LOCKED_SPACE_NAME})`;
    await sql`INSERT INTO pages (id, tenant_id, space_id, title) VALUES (${LOCKED_PAGE_ID}, ${E2E.tenant}, ${LOCKED_SPACE_ID}, 'locked page')`;
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
