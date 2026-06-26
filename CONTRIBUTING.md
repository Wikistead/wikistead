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
  direction. Note the product's north star (see `the project design notes`): a best-in-class writing
  experience, knowledge-first, open formats, link-first.

## Security

Please do **not** file security vulnerabilities in public issues. Use the project's private
security contact / advisory channel (to be published before launch).

## Building from source (self-hosting / inspection)

- Dev: `docker compose up -d` (middleware) → `pnpm install` → `pnpm dev`
- Checks: `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm license:check`

## Licensing of contributions

Because of the no-PR policy above, all code in this repository is authored under the
project's license. SPDX identifier: `AGPL-3.0-only`.
