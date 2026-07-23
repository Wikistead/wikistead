// #484: per-session isolation for the shared test stacks. Three worktrees (a/b/c) run their suites
// against the SAME server-test / e2e middleware, so they collide on ports, the FGA store, and the
// dev/demo fixtures — the source of the rotating single-file flakes tracked in #482.
//
// The isolation is OPT-IN and DEFAULT-PRESERVING: set `WKS_STACK_OFFSET` to a small integer per
// session and every port, the compose project name (and thus the volumes), and the connection URLs
// shift by a fixed stride. UNSET — the state every existing script and CI job is in today — resolves
// to offset 0, which is byte-identical to the hardcoded values that shipped before this change. A
// session opts into isolation; nothing opts out of what worked.
export function stackOffset() {
  const raw = process.env.WKS_STACK_OFFSET;
  const n = raw == null || raw === "" ? 0 : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 9) {
    throw new Error(`WKS_STACK_OFFSET must be an integer 0..9 (got ${JSON.stringify(raw)})`);
  }
  return n;
}

// The server-test port map. Offset 0 = the values that were hardcoded in docker-compose.server-test.yml
// and .env.server-test; each step of the offset adds 100 so the bands never overlap (and stay clear of
// the dev stack on 5432/6379/8080/7700/9000/1025).
export function serverTestPorts(offset = stackOffset()) {
  const s = offset * 100;
  return {
    offset,
    project: offset === 0 ? "wikistead-server-test" : `wikistead-server-test-${offset}`,
    pg: 5434 + s,
    valkey: 6381 + s,
    fgaHttp: 8092 + s,
    fgaGrpc: 8093 + s,
    meili: 7702 + s,
    s3: 9003 + s,
    smtp: 1027 + s,
    mailpit: 8027 + s,
  };
}

// The env the compose file interpolates (see docker-compose.server-test.yml). Passing these on the
// `docker compose` invocation is what moves the stack; the file's `${VAR:-default}` fallbacks keep a
// bare `docker compose -f …` (no offset) on the original ports.
export function serverTestComposeEnv(p = serverTestPorts()) {
  return {
    COMPOSE_PROJECT_NAME: p.project,
    SRVTEST_PG_PORT: String(p.pg),
    SRVTEST_VALKEY_PORT: String(p.valkey),
    SRVTEST_FGA_HTTP_PORT: String(p.fgaHttp),
    SRVTEST_FGA_GRPC_PORT: String(p.fgaGrpc),
    SRVTEST_MEILI_PORT: String(p.meili),
    SRVTEST_S3_PORT: String(p.s3),
    SRVTEST_SMTP_PORT: String(p.smtp),
    SRVTEST_MAILPIT_PORT: String(p.mailpit),
  };
}

// The e2e stack (#484 slice 2). Unlike server-test, e2e ALSO runs three app processes (server / collab
// / web) plus a real-auth web and a fixed OIDC issuer, started by Playwright's webServer — so its port
// map has an app band on top of the middleware band.
//
// MIDDLEWARE band: same stride-100 scheme as server-test, but the bases sit ONE below their server-test
// counterparts (pg 5433 vs 5434, fga 8090 vs 8092, …). At stride 100 the two families' bands are
// {base + 100k} sets that never intersect (they differ by a constant < 100), so an e2e stack at any
// offset can never collide with a server-test stack at any offset. Offset 0 reproduces the values that
// were hardcoded in docker-compose.e2e.yml / .env.e2e byte-for-byte.
//
// APP band: offset 0 keeps the shipped literals (4010/4110/5180/5181/4444). An ISOLATED session
// (offset >= 1) can't derive from those with a small stride without a neighbour collision — server 4010
// and collab 4110 are only 100 apart — and must also dodge the dev app ports (4000/4100/5173). So an
// isolated session's app ports live in a dedicated high band (42xxx) that nothing else uses; each
// offset gets a 20-wide window, each service a fixed slot inside it. The `stack-offset` pin proves the
// whole map is collision-free across offsets 0..9 and against the server-test and dev stacks.
export function e2ePorts(offset = stackOffset()) {
  const s = offset * 100;
  const app =
    offset === 0
      ? { server: 4010, collab: 4110, web: 5180, webReal: 5181, issuer: 4444 }
      : (() => {
          const start = 42000 + (offset - 1) * 20; // 20-wide window per isolated offset
          return { server: start, collab: start + 2, web: start + 4, webReal: start + 6, issuer: start + 8 };
        })();
  return {
    offset,
    project: offset === 0 ? "wikistead-e2e" : `wikistead-e2e-${offset}`,
    // middleware
    pg: 5433 + s,
    valkey: 6380 + s,
    fgaHttp: 8090 + s,
    fgaGrpc: 8091 + s,
    meili: 7701 + s,
    s3: 9002 + s,
    smtp: 1026 + s,
    mailpit: 8026 + s,
    // app processes
    ...app,
  };
}

// The env the e2e compose file interpolates (docker-compose.e2e.yml). COMPOSE_PROJECT_NAME + the host
// ports + the S3 CORS origin (which must match THIS stack's web port, else browser direct-upload fails).
export function e2eComposeEnv(p = e2ePorts()) {
  return {
    COMPOSE_PROJECT_NAME: p.project,
    E2E_PG_PORT: String(p.pg),
    E2E_VALKEY_PORT: String(p.valkey),
    E2E_FGA_HTTP_PORT: String(p.fgaHttp),
    E2E_FGA_GRPC_PORT: String(p.fgaGrpc),
    E2E_MEILI_PORT: String(p.meili),
    E2E_S3_PORT: String(p.s3),
    E2E_SMTP_PORT: String(p.smtp),
    E2E_MAILPIT_PORT: String(p.mailpit),
    E2E_WEB_ORIGIN: `http://dev.localhost:${p.web}`,
  };
}

// The connection URLs + app ports for THIS e2e stack, injected into every child process (migrate / fga
// bootstrap / seeds / the Playwright-spawned app servers). Real env vars beat --env-file in Node, so
// these move the suite onto the offset stack regardless of which env files a command names — the same
// override the server-test setup relies on (see scripts/server-test-up.mjs). At offset 0 they equal the
// static .env.e2e values.
export function e2eStackEnv(p = e2ePorts()) {
  return {
    DATABASE_URL: `postgres://app:app@localhost:${p.pg}/app`,
    DATABASE_ADMIN_URL: `postgres://postgres:postgres@localhost:${p.pg}/app`,
    VALKEY_URL: `redis://localhost:${p.valkey}`,
    OPENFGA_API_URL: `http://localhost:${p.fgaHttp}`,
    MEILI_HOST: `http://localhost:${p.meili}`,
    S3_ENDPOINT: `http://localhost:${p.s3}`,
    SMTP_PORT: String(p.smtp),
    SERVER_PORT: String(p.server),
    COLLAB_PORT: String(p.collab),
    WEB_PORT: String(p.web),
  };
}

// The dev stack's fixed host ports — NOT parameterized (one dev stack per machine). Exposed so the
// collision pin can prove no isolated test stack ever lands on a dev port.
export const DEV_PORTS = Object.freeze({
  pg: 5432, valkey: 6379, fgaHttp: 8080, fgaGrpc: 8081, kroki: 3000, meili: 7700, s3: 9000, smtp: 1025,
  mailpit: 8025, server: 4000, collab: 4100, web: 5173,
});
