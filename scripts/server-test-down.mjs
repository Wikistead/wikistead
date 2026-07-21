// teardown:server-test — remove the isolated server-test middleware AND its volumes, so the
// next run starts from a clean data layer. #268.
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serverTestComposeEnv } from "./stack-offset.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
// #484: tear down THIS session's project (offset-derived name), not a hardcoded one.
execSync("docker compose -f docker-compose.server-test.yml down -v", {
  cwd: repo, stdio: "inherit", env: { ...process.env, ...serverTestComposeEnv() },
});
