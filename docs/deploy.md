# Деплой

Всё живёт в `docker compose` на одной Linux-машине: на хосте нужны только Docker и
Compose v2 — ни Node, ни pnpm, ни Qt. Библиотека (коллекция и архивы) — каталог на дисках
этой же машины; сетевых хранилищ раскладка не поддерживает намеренно (почему — в
[decisions.md](decisions.md), решение 12).

```
браузер → caddy  (TLS + собранная SPA)
              └→ api    (Node/Fastify)  → /library/collection.db  (ro)
                                        → app.db, кэш обложек     (свои тома)
                                        → opds  (C++ FLibrary)    — обложки и файлы книг
                                             └→ /library/collection.db, /library/archives (ro)
```

Наружу смотрит только `caddy`. `api` доступен ему по внутренней сети, `opds` — только `api`:
у C++-сервера ручки `/Images/*` и его JSON-API не защищены авторизацией вообще, поэтому
публиковать его порт нельзя.

## Образы

| Сервис  | Из чего собирается       | Что внутри                                                 |
| ------- | ------------------------ | ---------------------------------------------------------- |
| `caddy` | `deploy/web.Dockerfile`  | SPA собирается в образе (node + pnpm), отдаёт Caddy        |
| `api`   | `deploy/api.Dockerfile`  | Fastify + `better-sqlite3` (нативный, собирается в образе) |
| `opds`  | `deploy/opds.Dockerfile` | официальная портативная сборка FLibrary + headless-weston  |

C++-сервер **не собирается из исходников**: это Qt 6.10+ и Conan, часы сборки. Берётся
портативный релиз из [heimdallr/books](https://github.com/heimdallr/books/releases) — в нём
уже есть `opds`, Qt 6.11 и `7z.so`. Версия задаётся `FLIBRARY_VERSION`.

## Первый запуск

```bash
cd deploy
cp .env.example .env && chmod 600 .env      # заполнить: SESSION_SECRET, LIBRARY_PATH, домен
openssl rand -hex 32                        # в SESSION_SECRET

docker compose up -d --build

# пользователи — только через CLI, регистрации в приложении нет
docker compose exec api node dist/cli/users.js add user 'пароль'

# поисковый индекс: морфология, релевантность, подстроки
docker compose exec api node dist/cli/reindex.js
```

До первой индексации поиск работает по FTS коллекции — без морфологии, но работает; в логе
`api` при старте про это предупреждение.

`docker compose logs -f api opds` — если что-то не поднялось.

## Где что лежит на хосте

| Что                                          | Где на машине                                      | Как подключено            |
| -------------------------------------------- | -------------------------------------------------- | ------------------------- |
| `collection.db` + архивы книг                | `LIBRARY_PATH` из `.env` (например `/srv/library`) | bind-mount `/library:ro`  |
| `app.db` (пользователи, сессии, свои данные) | том `flibrary-web_app-db`                          | `/var/lib/flibrary-web`   |
| кэш обложек                                  | том `flibrary-web_cover-cache`                     | `/var/cache/flibrary-web` |
| сертификаты и конфиг Caddy                   | тома `flibrary-web_caddy-data`, `…_caddy-config`   | `/data`, `/config`        |

Именованные тома Docker — это каталоги в `/var/lib/docker/volumes/<имя>/_data` на той же
машине; ничего сетевого в раскладке нет.

`LIBRARY_PATH` монтируется длинным синтаксисом с `create_host_path: false`: при опечатке в
пути compose не создаст пустой каталог от root, а откажется поднимать сервис. Проверить,
что коллекция на месте:

```bash
docker compose exec api ls -la /library
```

Прав на запись библиотеке не нужно: `/Images/*` (обложки и файлы книг) на read-only
коллекции работают. Бэкапить стоит `app.db` — всё остальное восстанавливается пересборкой
и переиндексацией:

```bash
docker compose stop api
docker run --rm -v flibrary-web_app-db:/data:ro -v "$PWD":/backup \
    alpine tar czf /backup/app-db.tar.gz -C /data .
docker compose start api
```

## Проверка

Поиск и скачивание после развёртывания:

```bash
site=https://library.example.com

# вход, кука сессии в cookies.txt
curl -sS -c cookies.txt -X POST $site/api/v1/auth/login \
    -H 'content-type: application/json' -d '{"login":"user","password":"пароль"}'

# поиск: один текстовый предикат, страница выдачи
curl -sS -b cookies.txt -X POST $site/api/v1/search \
    -H 'content-type: application/json' \
    -d '{"where":{"field":"any","op":"match","value":"стругацкий"},"limit":3}'

# счётчики фасетов и общее число совпадений — отдельной операцией
curl -sS -b cookies.txt -X POST $site/api/v1/search/facets \
    -H 'content-type: application/json' \
    -d '{"where":{"field":"any","op":"match","value":"стругацкий"},"facets":["lang","ext"]}'

# скачивание в исходном формате: должен приехать fb2 (или что лежит в архиве)
curl -sS -b cookies.txt -D - -o book.bin "$site/api/v1/books/<bookId>/content?format=original"
file book.bin
```

В ответе на скачивание ожидаются `content-type` от C++-сервера и
`content-disposition: attachment; filename="book-<id>.fb2"; filename*=UTF-8''<имя>`.

В браузере: логин → поиск → карточка книги → «Скачать fb2». Обложки в выдаче — тоже признак
того, что `api` дошёл до `opds`.

## Обновление коллекции

Коллекцию обновляет десктопный FLibrary на машине с библиотекой (или `opds` с `--inpx`, но
у нас он запущен без аргументов и с автообновлением, выключенным намеренно — см. грабли).
После обновления файла:

```bash
docker compose restart opds        # перечитать коллекцию
docker compose exec api node dist/cli/reindex.js
```

`reindex` без аргументов дописывает в индекс только новые поставки — на большой коллекции
это секунды вместо полной сборки. Полная сборка нужна, если книги правили в десктопе
(импорт `UpdateID` не двигает): `node dist/cli/reindex.js --force`.

Кэш счётчиков фасетов и `total` обесценивается сам: в его ключе отпечаток файла коллекции.

## Грабли C++-сервера (проверено на 2.6.6)

Это то, что стоило времени; в образе и в `deploy/opds-entrypoint.sh` всё уже учтено.

- **`--database` и `--archives` пересоздают коллекцию.** Запуск
  `opds --name X --database collection.db --archives ...` на **существующей** коллекции
  превратил 5000 книг в 0: аргументы понимаются как «создай коллекцию», файл
  переинициализируется. Поэтому коллекция регистрируется QSettings-конфигом
  (`$HOME/.config/HomeCompa/FLibrary.conf`), а `opds` запускается без аргументов.
- **Нет плагина `offscreen`.** `opds` линкует Qt Gui, без платформенного плагина не стартует,
  а в портативной сборке лежат только `xcb` (без `libQt6XcbQpa` — нерабочий) и `wayland`.
  Подложить `offscreen` из пакетов дистрибутива нельзя: QPA-плагины грузятся только при
  совпадении major.minor Qt («Ignoring QPA plugin due to mismatching Qt versions», в Ubuntu
  Qt 6.10 против 6.11 в сборке). Отсюда weston с headless-бэкендом в образе — ни GPU, ни
  устройств ввода ему не нужно.
- **Нужен libstdc++ от gcc 16** (`GLIBCXX_3.4.35`): релиз собран им. В Ubuntu 26.04 штатный,
  в 24.04 такого нет — поэтому база образа именно 26.04.
- **Коллекция read-only: `/Images/*` работают, OPDS-каталог нет.** На старте `opds` создаёт
  представление `Books_View_Opds`, то есть пишет в коллекцию. Если файл только для чтения,
  обложки и файлы книг всё равно отдаются (проверено), а `/opds`, `/web` и `/main/getBooks/*`
  отдают пустоту. Нам этого достаточно — мы проксируем только `/Images/*`. Если нужен
  OPDS-каталог для читалок, уберите `read_only: true` у тома `/library` в сервисе `opds`
  **и** оставьте автообновление коллекции выключенным.
- **Падает по segfault, если клиент обрывает соединение** на середине выдачи: 30 оборванных
  запросов к `/Images/covers/*` напрямую роняют процесс (`segfault ... in liblogic.so`).
  Через `api` это не воспроизводится — обложки он вычитывает целиком, — но `restart:
unless-stopped` у `opds` не косметика: после падения сервис поднимается сам, и на время
  перезапуска бинарные ручки отдают 502.
- **502 на существующей книге** обычно значит, что файла нет в архиве (или архив не на месте):
  C++-сервер в таком случае закрывает соединение без ответа.

## Локальный content-service для разработки

Тот же C++-сервер, но без Docker — чтобы обложки и скачивание работали в `pnpm dev`:

```bash
apt install weston libegl1 libopengl0      # почему weston — см. грабли выше
scripts/opds-local.sh                      # коллекция и архивы из data/ (pnpm fixtures)
scripts/opds-local.sh --database /srv/library/collection.db --archives /srv/library/archives
scripts/opds-local.sh --stop
```

Скрипт скачивает портативный релиз в `data/opds` (не коммитится), при необходимости
докладывает рядом рантайм gcc-16, поднимает weston и запускает `opds` на `127.0.0.1:12791` —
адрес, который `api` берёт по умолчанию. Без него обложки и скачивание отдают 502.
