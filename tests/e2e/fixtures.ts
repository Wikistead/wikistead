import postgres from "postgres";

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
