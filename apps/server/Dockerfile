# syntax=docker/dockerfile:1
# CE server image (#414 / ADR-161 pre-slice). CE-ONLY build context: the COPY list below names the CE
# workspace packages the server depends on — NEVER `COPY packages ./packages`, which would embed the
# proprietary EE packages (packages/ee-server, packages/entitlements-cloud) into an AGPL artifact
# (ADR-084 boundary; the EE image builds from the private overlay repo with its own Dockerfile).
FROM node:20-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
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
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @wikistead/server... build
# Self-contained production tree: the app + its workspace deps (dist) + prod node_modules only —
# no dev toolchain, no test-only devDependencies (entitlements-cloud is a devDependency and stays out).
RUN pnpm --filter @wikistead/server deploy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /out /app
WORKDIR /app
CMD ["node", "dist/index.js"]
