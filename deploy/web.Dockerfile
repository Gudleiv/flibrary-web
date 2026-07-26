# Сборка SPA и статика в одном образе: Caddy отдаёт уже собранный `dist`.
#
# Собираем именно в образе, а не на хосте, чтобы на сервере не требовались ни Node, ни
# pnpm: `docker compose up --build` — единственное, что нужно для деплоя.

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY fixtures/package.json fixtures/
RUN pnpm install --frozen-lockfile --filter @flibrary/web... || pnpm install --filter @flibrary/web...

COPY tsconfig.base.json ./
COPY packages/contract packages/contract
COPY packages/web packages/web

# Типы клиента генерируются из openapi.yaml — без контракта vue-tsc не пройдёт.
RUN pnpm --filter @flibrary/contract build \
    && pnpm --filter @flibrary/web build

FROM caddy:2-alpine

# Caddyfile монтируется из deploy/ (в нём домен, его правят чаще, чем код),
# а собранная статика вшита в образ.
COPY --from=build /app/packages/web/dist /srv/web
