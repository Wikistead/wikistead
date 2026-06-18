// teardown:e2e — remove the isolated e2e middleware AND its volumes, so the next
// run starts from a clean data layer.
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
execSync("docker compose -f docker-compose.e2e.yml down -v", { cwd: repo, stdio: "inherit" });
