# syntax=docker/dockerfile:1
# CE server image (#414 / ADR-161 pre-slice). CE-ONLY build context: the COPY list below names the CE
# workspace packages the server depends on — NEVER `COPY packages ./packages`, which would embed the
# proprietary EE packages (packages/ee-server, packages/entitlements-cloud) into an AGPL artifact
# (ADR-084 boundary; the EE image builds from the private overlay repo with its own Dockerfile).
FROM node:20-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
# The LOCKFILE travels too. Without it every dependency re-resolves to the newest match of its range, so
# the image compiled against a different SDK than the repo pins — measured: `stripe: ^22.2.1` resolved past
# the pinned 22.2.1 and its `apiVersion` literal type moved, failing routes/billing.ts in the image while
# every local check stayed green. The install below stays non-frozen because the devDependency surgery on
# line 30 edits package.json after this copy; with the lockfile present pnpm still reuses the pinned
# versions for everything it does not have to re-resolve.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/types ./packages/types
COPY packages/hooks ./packages/hooks
COPY packages/auth ./packages/auth
COPY packages/authz ./packages/authz
COPY packages/entitlements ./packages/entitlements
COPY packages/events ./packages/events
COPY packages/macro-render ./packages/macro-render
COPY apps/server ./apps/server
# Strip the test-only proprietary devDependency from the CE build context: entitlements-cloud is not
# COPY'd (by design), and pnpm resolves workspace:^ references even for devDependencies. This line
# disappears with #178 (EE physical separation removes the reference from the public tree entirely).
RUN node -e "const fs=require('fs');const f='apps/server/package.json';const p=JSON.parse(fs.readFileSync(f));delete p.devDependencies['@wikistead/entitlements-cloud'];fs.writeFileSync(f,JSON.stringify(p,null,2))"
# …and the tests that import it. `tsc -b` compiles this directory too, so nineteen TS2307s came from files
# that are not part of the artifact and never could be: the package they import is deliberately outside the
# CE build context. Removing them here (image-local, like the line above) rather than excluding them from
# the repo's tsconfig, which would stop local typechecking from seeing them.
RUN rm -rf apps/server/src/__tests__
# The root package.json has a `postinstall` (#694's push-guard wiring), and `pnpm install`
# runs it — so the script has to BE here or the build dies on a missing module. It self-disables
# outside a dev checkout (it looks for the project design notes, which no image copies), so shipping it costs a
# 2 KB file and nothing else. Measured: without this line every image build fails (#726).
COPY scripts/wire-git-hooks.mjs ./scripts/wire-git-hooks.mjs
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @wikistead/server... build
# Self-contained production tree: the app + its workspace deps (dist) + prod node_modules only —
# no dev toolchain, no test-only devDependencies (entitlements-cloud is a devDependency and stays out).
RUN pnpm --filter @wikistead/server deploy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /out /app
# #804: the schema travels with the code that expects it. `pnpm deploy` produces the PACKAGE and its
# production dependencies, and the SQL lives outside the package — so an operator holding only this
# image had no way to create a database, and the first real Kubernetes deployment had to carry 130
# files in a ConfigMap to get one (#802). Beside the package, where migrate.js looks second
# (src/migrations-dir.ts); the repository layout it looks at last is three levels above /app and
# therefore outside the image entirely.
COPY infra/db/migrations /app/migrations
# ADR-253 §3.2: same shape, same reason — an operator holding only the image needs the authorization
# model to self-resolve the OpenFGA store/model, and infra/ (where the DSL lives in a checkout) is
# outside the image. Beside the package, where openfga-model-path.ts looks first; unlike the
# migrations there is no environment-variable override, because an authorization model may not
# differ from the one this code was built against.
COPY infra/openfga/model.fga /app/model.fga
WORKDIR /app
CMD ["node", "dist/index.js"]
