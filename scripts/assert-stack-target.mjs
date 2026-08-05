import { stackOffset, e2ePorts, serverTestPorts } from "./stack-offset.mjs";

// #621: which STACK is this command about to write to?
//
// The offset (#484) moves every port so three sessions can run the same suites side by side, and the
// setup scripts inject the moved connection URLs because `--env-file` alone still names the ORIGINAL
// ports. Run one of those steps by hand — `npx tsx --env-file=.env.e2e infra/db/seed.ts`, the obvious
// thing to type when a fixture looks stale — and it quietly seeds SOMEBODY ELSE'S stack. Measured: it
// did, while investigating this very ticket, and the only reason it was noticed is that the row the
// investigation was watching did not change.
//
// The scripts' own comments already warn about the split-brain. A warning is not a guard, so this is
// the guard: with an offset set, the connection has to belong to that offset's stack, or the command
// stops before touching anything. Offset unset (CI, a plain checkout) is the historical behaviour and
// is left exactly alone.
export function assertStackTarget(url, what) {
  const offset = stackOffset();
  if (offset === 0 || !url) return; // no isolation asked for — nothing to get wrong
  let port;
  try {
    port = Number(new URL(url).port);
  } catch {
    return; // not a URL we can read — leave it to the caller's own failure
  }
  const expected = [e2ePorts(offset).pg, serverTestPorts(offset).pg];
  if (expected.includes(port)) return;
  throw new Error(
    `${what}: WKS_STACK_OFFSET=${offset} is set, but the database is on port ${port} — that is another ` +
      `session's stack (this offset uses ${expected.join(" or ")}). Refusing to write to it. Run the ` +
      `setup script (pnpm setup:e2e / pnpm setup:server-test) with the same offset, which injects the ` +
      `right connection URLs, instead of passing --env-file by hand.`,
  );
}
