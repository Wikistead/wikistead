# syntax=docker/dockerfile:1
# CE collab image (#414 / ADR-161 pre-slice). CE-ONLY COPY list (see apps/server/Dockerfile for why
# `COPY packages ./packages` is forbidden — the ADR-084 artifact boundary).
FROM node:20-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/types ./packages/types
COPY packages/hooks ./packages/hooks
COPY packages/auth ./packages/auth
COPY packages/authz ./packages/authz
COPY apps/collab ./apps/collab
# The root package.json has a `postinstall` (#694's push-guard wiring), and `pnpm install`
# runs it — so the script has to BE here or the build dies on a missing module. It self-disables
# outside a dev checkout (it looks for the project design notes, which no image copies), so shipping it costs a
# 2 KB file and nothing else. Measured: without this line every image build fails (#726).
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @wikistead/collab... build
RUN pnpm --filter @wikistead/collab deploy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /out /app
WORKDIR /app
CMD ["node", "dist/index.js"]
