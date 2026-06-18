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
    await sql`DELETE FROM spaces WHERE tenant_id = ${E2E.tenant} AND name = ${LOCKED_SPACE_NAME}`;
    const [s] = await sql`
      INSERT INTO spaces (tenant_id, name) VALUES (${E2E.tenant}, ${LOCKED_SPACE_NAME}) RETURNING id`;
    await sql`
      INSERT INTO pages (tenant_id, space_id, title) VALUES (${E2E.tenant}, ${s.id}, 'locked page')`;
  } finally {
    await sql.end();
  }

  // --- ensure Meili index + filterable attrs, then add the stale doc ---
  await meili(`/indexes`, { method: "POST", body: JSON.stringify({ uid: E2E.index, primaryKey: "id" }) });
  await meili(`/indexes/${E2E.index}/settings/filterable-attributes`, {
    method: "PUT",
    body: JSON.stringify(["tenantId", "spaceId", "viewerUsers", "viewerGroups", "isPublic"]),
  });
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
