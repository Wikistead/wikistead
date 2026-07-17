import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedFgaFixtures } from "../fixtures";

// #444: a trash/private spec that dies mid-run leaves DENY markers on the shared demo fixture, and
// re-asserting grants never healed them (deny-side) — page:demo went byte-invisible for every later
// run, twice on 2026-07-17. seedFgaFixtures now strips the known marker pairs from the shared
// objects. This pin plants the residue and proves one seed pass removes it.
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

test("#444: the seed strips stale deny markers from the shared demo fixture", async () => {
  // plant the residue a killed trash spec would leave
  for (const user of ["user:*", "share_link:*"]) {
    await fetch(`${FGA}/stores/${STORE}/write`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ writes: { tuple_keys: [{ user, relation: "trashed", object: "page:demo" }] }, authorization_model_id: MODEL }),
    });
  }
  expect(await readMarkers("page:demo", "trashed"), "residue planted").toBeGreaterThan(0);
  // one seed pass (what globalSetup runs) heals it
  await seedFgaFixtures();
  expect(await readMarkers("page:demo", "trashed"), "seed removed the markers").toBe(0);
});
