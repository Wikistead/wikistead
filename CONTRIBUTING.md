# Contributing to Wikistead

Thanks for your interest in Wikistead.

## Code pull requests are not accepted (for now)

Wikistead does **not** currently accept external code contributions (pull requests).
Incoming PRs will be closed with a pointer to this policy — please don't take it
personally; it keeps the licensing story simple while the project is young.

- The Community Edition (this repository) is licensed under **AGPL-3.0-only** (see
  [`LICENSE`](./LICENSE)).
- The Enterprise Edition lives in a **separate repository** (`wikistead-ee`), so everything
  in this repo is uniformly AGPL.

We may begin accepting contributions under a **required CLA** once a community forms. This
file will be updated when that changes.

## Bug reports and feature ideas are very welcome

Please open an **Issue**:

- **Bug reports** — steps to reproduce, expected vs. actual behaviour, the version/commit,
  and your environment.
- **Feature requests / ideas** — the problem you're trying to solve and your proposed
  direction. Note the product's north star: a best-in-class writing
  experience, knowledge-first, open formats, link-first.

## Security

Please do **not** file security vulnerabilities in public issues. Report them privately —
see [`SECURITY.md`](./SECURITY.md) for the process (GitHub private vulnerability reporting).

## Running it from source

```bash
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local   # web → API on dev.localhost (tenant routing)
pnpm install
pnpm dev:up                                    # middleware + first-run bootstrap
pnpm dev                                       # server, collab and web on the host
```

`pnpm dev:up` is `docker compose up -d` plus `dev:setup`, which migrates and seeds the
application database (a demo tenant, space and page) and creates the OpenFGA store and
authorization model. Running `pnpm dev` without it leaves you on an empty database with no
authorization model, which looks like a broken app. The bootstrap is idempotent and
first-run-only: OpenFGA persists to Postgres, so a restart never needs it again — only
`docker compose down -v` does.

Then open **http://dev.localhost:5173/p/demo**. The API resolves the tenant from the `Host` header,
and the web app calls a RELATIVE `/api` — the dev server proxies it (the proxy table is generated
from `infra/routes/origin-routes.mjs`, #724). The host matters, not the port: `localhost:5173` and
`dev.localhost:5173` resolve to different tenants.

To run the whole product in containers instead — web, server, collab and a reverse proxy on one
origin — `docker compose --profile apps up -d --build`, then open **https://dev.localhost**. That
profile pins `NODE_ENV=production`, so the `dev-token` bearer the dev loop accepts does not work
there, and the certificate is Caddy's internal one until you `caddy trust` it.

### Checks

```bash
pnpm build && pnpm typecheck && pnpm license:check
pnpm setup:server-test        # server integration tests get their own stack: separate
pnpm test                     # containers, ports and volumes — dev data is never touched
pnpm teardown:server-test     # optional
```

The server suite runs against a real Postgres and a real OpenFGA, not fakes;
`apps/server/vitest.config.ts` points it at that isolated stack. Set it up once — the
containers persist between runs.

## Licensing of contributions

Because of the no-PR policy above, all code in this repository is authored under the
project's license. SPDX identifier: `AGPL-3.0-only`.
