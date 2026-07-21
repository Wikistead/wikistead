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
