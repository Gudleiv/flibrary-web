#!/bin/bash
# Готовит окружение для сессий Claude Code on the web: зависимости, контракт, данные
# для разработки, поисковый индекс и dev-пользователь.
#
# Без этого каждая новая сессия начинается с полудюжины ручных команд, причём неочевидных:
# без сборки контракта не пройдёт даже typecheck (типы генерируются), без фикстур нечем
# кормить API, без индекса поиск работает в урезанном режиме.
#
# Скрипт идемпотентен: повторный запуск ничего не переделывает.
set -euo pipefail

# Локально окружение настраивает сам разработчик.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
	exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$(dirname "$(dirname "$(readlink -f "$0")")")")}"

# Объём фикстур по умолчанию. Хватает, чтобы поиск и фасеты вели себя осмысленно, и
# генерируется за секунды. Для замеров производительности:
#   pnpm fixtures -- --books=50000
FIXTURE_BOOKS="${FIXTURE_BOOKS:-5000}"

corepack enable >/dev/null 2>&1 || true

# 7-Zip нужен отзывам читателей: и генератору фикстур, чтобы собрать архив, и API,
# чтобы его прочитать. Без него всё остальное работает, просто раздела отзывов не будет.
if ! command -v 7z >/dev/null 2>&1; then
	echo "==> 7-Zip (для отзывов читателей)"
	apt-get install --yes p7zip-full >/dev/null 2>&1 || echo "    не установился — отзывов не будет"
fi

echo "==> Зависимости"
pnpm install --prefer-offline

echo "==> Контракт (TS-типы и JSON Schema из openapi.yaml)"
pnpm --filter @flibrary/contract build

if [ -f data/collection.db ]; then
	echo "==> Фикстуры: уже есть"
else
	# Архивы с fb2 нужны только C++-серверу, которого в облачной сессии нет,
	# поэтому не тратим на них время и диск.
	echo "==> Фикстуры: ${FIXTURE_BOOKS} книг"
	pnpm fixtures -- "--books=${FIXTURE_BOOKS}" --no-archives
fi

echo "==> Поисковый индекс"
pnpm --filter @flibrary/api reindex

# Учётка для ручной проверки в браузере. Только для облачной сессии с синтетическими
# данными: в проде пользователи заводятся командой users add.
if pnpm --filter @flibrary/api users list 2>/dev/null | grep -q '^dev '; then
	echo "==> Пользователь dev: уже есть"
else
	echo "==> Пользователь dev / dev"
	pnpm --filter @flibrary/api users add dev dev "Разработчик"
fi

cat <<'EOF'

Окружение готово.
  pnpm dev                            api :3000 и web :5173, вход dev / dev
  pnpm typecheck && pnpm lint         перед коммитом
  pnpm --filter @flibrary/api test    тесты

Обложки и скачивание книг отдают 502: за них отвечает C++-сервер FLibrary,
которого здесь нет. Это ожидаемо, см. CLAUDE.md.
EOF
