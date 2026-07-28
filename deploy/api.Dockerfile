# Сборка API. Многостадийная: better-sqlite3 нативный, поэтому в рантайм-образ
# переносим уже собранные node_modules.

FROM node:22-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# better-sqlite3 при отсутствии готового prebuild собирается через node-gyp.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contract/package.json packages/contract/
COPY packages/api/package.json packages/api/
COPY packages/web/package.json packages/web/
COPY fixtures/package.json fixtures/
RUN pnpm install --frozen-lockfile --filter @flibrary/api... || pnpm install --filter @flibrary/api...

COPY tsconfig.base.json ./
COPY packages/contract packages/contract
COPY packages/api packages/api

# Типы и JSON Schema генерируются из openapi.yaml — без этого api не соберётся.
RUN pnpm --filter @flibrary/contract build \
    && pnpm --filter @flibrary/api build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# 7-Zip — для отзывов читателей: они лежат в 7z-архивах «дополнительной папки»
# коллекции (ADDITIONAL_DIR). Рабочих чистых JS-распаковщиков 7z нет, а wasm-сборка
# ради необязательной функции дороже этой строчки. Без ADDITIONAL_DIR не нужен вовсе.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends p7zip-full \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/contract ./packages/contract
COPY --from=build /app/packages/api/node_modules ./packages/api/node_modules
COPY --from=build /app/packages/api/dist ./packages/api/dist
COPY --from=build /app/packages/api/package.json ./packages/api/package.json

# Миграции app.db лежат рядом с кодом и читаются в рантайме.
COPY --from=build /app/packages/api/src/db/migrations ./packages/api/dist/db/migrations

RUN mkdir -p /var/lib/flibrary-web /var/cache/flibrary-web

WORKDIR /app/packages/api
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
