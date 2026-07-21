import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedFgaFixtures, FIXTURE_OBJECTS, DENY_MARKER_RELATIONS, DENY_MARKER_USERS } from "../fixtures";

// #444: a trash/private spec that dies mid-run leaves DENY markers on the shared demo fixture, and
// re-asserting grants never healed them (deny-side) — page:demo went byte-invisible for every later
// run, twice on 2026-07-17. seedFgaFixtures strips the known marker pairs from the shared objects.
//
//the first version of this pin planted ONE relation on ONE object, so narrowing the cleanup
// definition would have left it green. It now walks the definition itself (relation × object, both
// imported from fixtures.ts): drop a relation or an object from the sweep and the corresponding case
// starts failing here.
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

test("#444one seed pass strips EVERY deny-marker shape from EVERY shared fixture object", async () => {
  // plant the residue a killed spec would leave, across the whole definition
  for (const object of FIXTURE_OBJECTS) {
    for (const relation of DENY_MARKER_RELATIONS) {
      for (const user of DENY_MARKER_USERS) await plant(object, relation, user);
    }
  }
  // at least one marker must actually exist, else the pin proves nothing about the sweep
  const plantedCounts: number[] = [];
  for (const object of FIXTURE_OBJECTS) {
    for (const relation of DENY_MARKER_RELATIONS) plantedCounts.push(await readMarkers(object, relation));
  }
  expect(plantedCounts.reduce((a, b) => a + b, 0), "residue planted").toBeGreaterThan(0);

  // one seed pass (what globalSetup runs) heals all of it
  await seedFgaFixtures();
  for (const object of FIXTURE_OBJECTS) {
    for (const relation of DENY_MARKER_RELATIONS) {
      expect(await readMarkers(object, relation), `${relation} on ${object} was not swept`).toBe(0);
    }
  }
});
