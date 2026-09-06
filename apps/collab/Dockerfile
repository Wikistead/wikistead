# syntax=docker/dockerfile:1
# CE collab image (#414 / ADR-161 pre-slice). CE-ONLY COPY list (see apps/server/Dockerfile for why
# `COPY packages ./packages` is forbidden — the ADR-084 artifact boundary).
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
# The LOCKFILE travels too (see apps/server/Dockerfile for the measured drift this prevents: without
# it every dependency re-resolves to the newest match of its range on every build, not just the ones
# whose range actually widened). `--frozen-lockfile=false` stays (no post-copy package.json edit here
# to require it, but it matches this repo's other two image builds byte-for-byte rather than having a
# third, subtly different install invocation to reason about).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
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
