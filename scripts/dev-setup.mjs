#!/usr/bin/env node
// Idempotent dev bootstrap for OpenFGA authorization.
//
// #338 / ADR-128: the dev OpenFGA now runs on the PERSISTENT postgres datastore (docker-compose.yml:
// OPENFGA_DATASTORE_ENGINE=postgres, a dedicated `openfga` DB on the existing postgres) — matching prod. So
// the store + authorization model SURVIVE `docker compose down` / container recreate / reboot, and the
// OPENFGA_STORE_ID pinned in .env no longer dangles. This script is therefore genuinely FIRST-RUN-ONLY: on a
// fresh volume it bootstraps the store + model, rewrites the two OPENFGA_*_ID lines in .env, and seeds the demo
// tuples; on every subsequent run (same volume) it detects the existing store and does nothing.
//
// It is SAFE TO RUN REPEATEDLY. Run it after `docker compose up -d` on first setup (or after an explicit
// `docker compose down -v`, which wipes the volume and so re-triggers the one-time bootstrap). A plain
// restart/reboot no longer needs it — the store persists.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

const readEnvValue = (key) => {
  const m = readFileSync(envPath, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : undefined;
};

const apiUrl = readEnvValue("OPENFGA_API_URL") || "http://localhost:8080";
const storeId = readEnvValue("OPENFGA_STORE_ID");

async function storeExists(id) {
  if (!id) return false;
  try {
    const res = await fetch(`${apiUrl}/stores/${id}`);
    return res.ok; // 200 → exists; 404 (store_id_not_found) → wiped
  } catch {
    // OpenFGA not reachable yet — treat as "not ready" and tell the user to bring middleware up.
    console.error(`[dev:setup] cannot reach OpenFGA at ${apiUrl}. Run \`docker compose up -d\` first.`);
    process.exit(1);
  }
}

if (await storeExists(storeId)) {
  console.log(`[dev:setup] OpenFGA store ${storeId} exists — authz OK, nothing to do.`);
  process.exit(0);
}

console.log("[dev:setup] OpenFGA store missing/stale (in-memory datastore was reset) — bootstrapping…");
// fga:bootstrap creates the store + model and prints OPENFGA_STORE_ID=… / OPENFGA_MODEL_ID=… to stdout.
const out = execFileSync("pnpm", ["--filter", "@wikistead/server", "fga:bootstrap"], { cwd: root, encoding: "utf8" });
const newStore = (out.match(/^OPENFGA_STORE_ID=(.*)$/m) || [])[1]?.trim();
const newModel = (out.match(/^OPENFGA_MODEL_ID=(.*)$/m) || [])[1]?.trim();
if (!newStore || !newModel) {
  console.error("[dev:setup] fga:bootstrap did not print the store/model IDs:\n" + out);
  process.exit(1);
}

// Rewrite ONLY the two id lines in .env, leaving everything else byte-for-byte intact.
const updated = readFileSync(envPath, "utf8")
  .replace(/^OPENFGA_STORE_ID=.*$/m, `OPENFGA_STORE_ID=${newStore}`)
  .replace(/^OPENFGA_MODEL_ID=.*$/m, `OPENFGA_MODEL_ID=${newModel}`);
writeFileSync(envPath, updated);
console.log(`[dev:setup] .env updated → store ${newStore}, model ${newModel}`);

// Seed the demo tenant/space/page tuples (fga:seed reads the fresh .env via --env-file).
execFileSync("pnpm", ["--filter", "@wikistead/server", "fga:seed"], { cwd: root, stdio: "inherit" });
console.log("[dev:setup] done — authz store re-seeded. Now start the app: pnpm dev");
