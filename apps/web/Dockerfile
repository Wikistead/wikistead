# syntax=docker/dockerfile:1
# CE web image (#414 / ADR-161 pre-slice). CE-ONLY COPY list (ADR-084 artifact boundary). The runtime
# is static nginx — no node_modules; nginx.conf provides the SPA history fallback (react-router deep
# links / reloads must serve index.html) and the CORS header the opaque-origin pdf-frame needs to load
# its module scripts (#273 — public static assets, no credentials, so no boundary change).
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/macro-render ./packages/macro-render
COPY packages/i18n-shared ./packages/i18n-shared
COPY apps/web ./apps/web
# #724: the dev proxy is GENERATED from the origin route table, so vite.config.ts imports it — and a
# vite config is evaluated during `build`, not only during `dev`. Without this the image build dies
# resolving it. Measured (#726): broken since the table landed, invisible because the only thing that
# builds this image is a release tag and none has been minted.
COPY infra/routes ./infra/routes
# The root package.json has a `postinstall` (#694's push-guard wiring), and `pnpm install`
# runs it — so the script has to BE here or the build dies on a missing module. It self-disables
# outside a dev checkout (it looks for the project design notes, which no image copies), so shipping it costs a
# 2 KB file and nothing else. Measured: without this line every image build fails (#726).
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @wikistead/web... build

FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
