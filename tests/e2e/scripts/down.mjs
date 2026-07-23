// teardown:e2e — remove the isolated e2e middleware AND its volumes, so the next
// run starts from a clean data layer.
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2ePorts, e2eComposeEnv } from "../../../scripts/stack-offset.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// #484: tear down THIS session's stack — the COMPOSE_PROJECT_NAME must match the one `up` created, or
// `down -v` targets the wrong (or the default) project and leaves this one's volumes behind.
const env = { ...process.env, ...e2eComposeEnv(e2ePorts()) };
execSync("docker compose -f docker-compose.e2e.yml down -v", { cwd: repo, stdio: "inherit", env });
