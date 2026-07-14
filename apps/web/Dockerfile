# syntax=docker/dockerfile:1
# CE web image (#414 / ADR-161 pre-slice). CE-ONLY COPY list (ADR-084 artifact boundary). The runtime
# is static nginx — no node_modules; nginx.conf provides the SPA history fallback (react-router deep
# links / reloads must serve index.html) and the CORS header the opaque-origin pdf-frame needs to load
# its module scripts (#273— public static assets, no credentials, so no boundary change).
FROM node:20-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/macro-render ./packages/macro-render
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @wikistead/web... build

FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
