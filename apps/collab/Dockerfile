# syntax=docker/dockerfile:1
FROM node:20-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/collab ./apps/collab
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @kb/collab... build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
WORKDIR /repo/apps/collab
CMD ["node", "dist/index.js"]
