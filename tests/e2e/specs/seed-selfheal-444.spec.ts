import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedFgaFixtures, FIXTURE_OBJECTS, DENY_MARKER_RELATIONS, DENY_MARKER_USERS } from "../fixtures";

// #444: a trash/private spec that dies mid-run leaves DENY markers on the shared demo fixture, and
// re-asserting grants never healed them (deny-side) — page:demo went byte-invisible for every later
// run, twice on 2026-07-17. seedFgaFixtures strips the known marker pairs from the shared objects.
//
// the first version of this pin planted ONE relation on ONE object, so narrowing the cleanup
// definition would have left it green. It now walks the definition itself (relation × object, both
// imported from fixtures.ts).
//
// walking the definition is necessary but NOT sufficient — a pin that imports the same list it
// checks shrinks along with it, so deleting a relation from the sweep would still be green. The list
// below is a deliberate SECOND copy, written here so that narrowing the sweep has to be argued for in
// two places. Update it only together with the model: if `type page` gains another deny relation that
// accepts a typed wildcard (i.e. another marker a killed spec can strand on a shared object), add it
// here and to DENY_MARKER_RELATIONS. `restricted` stays out — it takes concrete principals only.
const EXPECTED_MARKER_RELATIONS = ["trashed", "private", "frozen", "frozen_guests"];
const repoEnv = readFileSync(fileURLToPath(new URL("../../../.env.e2e.local", import.meta.url)), "utf8");
const STORE = /OPENFGA_STORE_ID=(.+)/.exec(repoEnv)![1]!.trim();
const MODEL = /OPENFGA_MODEL_ID=(.+)/.exec(repoEnv)![1]!.trim();
const FGA = "http://localhost:8090";

async function readMarkers(object: string, relation: string): Promise<number> {
  const res = await fetch(`${FGA}/stores/${STORE}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tuple_key: { object, relation } }),
  });
  const json = (await res.json()) as { tuples?: unknown[] };
  return json.tuples?.length ?? 0;
}

// Plant one marker. A type-mismatched pair (frozen_guests × user:*) is refused by the model; that is
// expected and simply means there is no residue of that shape to clean.
async function plant(object: string, relation: string, user: string): Promise<void> {
  await fetch(`${FGA}/stores/${STORE}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ writes: { tuple_keys: [{ user, relation, object }] }, authorization_model_id: MODEL }),
  }).catch(() => {});
}

test("#444 the sweep definition itself has not been narrowed", () => {
  expect([...DENY_MARKER_RELATIONS].sort(), "the sweep must still cover every wildcard-deny relation")
    .toEqual([...EXPECTED_MARKER_RELATIONS].sort());
  expect([...DENY_MARKER_USERS].sort(), "both wildcard principal shapes must still be swept").toEqual(["share_link:*", "user:*"]);
  expect([...FIXTURE_OBJECTS], "every shared fixture object must still be swept")
    .toEqual(["page:demo", "space:demo_space", "page:acme_page", "space:acme_space"]);
});

test("#444 one seed pass strips EVERY deny-marker shape from EVERY shared fixture object", async () => {
  // plant the residue a killed spec would leave, across the whole definition
  for (const object of FIXTURE_OBJECTS) {
    for (const relation of DENY_MARKER_RELATIONS) {
      for (const user of DENY_MARKER_USERS) await plant(object, relation, user);
    }
  }
  // "at least one marker exists" was too weak to notice that half the matrix never plants
  // anything. These relations are defined on `type page` only, so the space rows CANNOT hold residue
  // and their post-sweep zero is true either way — they are a forward guard for the day the model
  // grows them, not coverage. Require the page rows, which carry the real residue, to be armed.
  for (const object of FIXTURE_OBJECTS.filter((o) => o.startsWith("page:"))) {
    for (const relation of DENY_MARKER_RELATIONS) {
      expect(await readMarkers(object, relation), `${relation} residue was never planted on ${object}, so sweeping it proves nothing`).toBeGreaterThan(0);
    }
  }

  // one seed pass (what globalSetup runs) heals all of it
  await seedFgaFixtures();
  for (const object of FIXTURE_OBJECTS) {
    for (const relation of DENY_MARKER_RELATIONS) {
      expect(await readMarkers(object, relation), `${relation} on ${object} was not swept`).toBe(0);
    }
  }
});
