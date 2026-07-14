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
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @wikistead/collab... build
RUN pnpm --filter @wikistead/collab deploy --prod /out

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /out /app
WORKDIR /app
CMD ["node", "dist/index.js"]
