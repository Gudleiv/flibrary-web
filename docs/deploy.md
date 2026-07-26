# Деплой

Всё живёт в `docker compose`: на хосте нужны только Docker и Compose v2 — ни Node, ни pnpm,
ни Qt. Библиотека (коллекция и архивы) подключается либо каталогом с хоста, либо SMB-шарой.

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

## Библиотека на SMB-шаре

```bash
docker compose -f docker-compose.yml -f docker-compose.smb.yml up -d --build
```

Оверрейд подменяет только том `library`, для сервисов ничего не меняется. Переменные
(`SMB_HOST`, `SMB_SHARE`, `SMB_PATH`, `SMB_USER`, `SMB_PASSWORD`, `SMB_VERS`) — в `.env`.

Что нужно знать:

- **cifs-utils ставится на хост.** Шару монтирует демон Docker, а не контейнер:
  `apt install cifs-utils`, модуль ядра `cifs` должен грузиться (`modprobe cifs`).
  Контейнерам не нужны ни привилегии, ни `CAP_SYS_ADMIN`.
- **`nobrl` обязателен.** SQLite берёт fcntl-блокировки даже на чтение, через CIFS они
  превращаются в серверные byte-range locks: в лучшем случае тормоза, в худшем —
  `SQLITE_BUSY`/`SQLITE_IOERR`. Том смонтирован `ro`, писателей нет, блокировки не нужны.
- **`vers` задаём явно.** Автонеговорка с частью NAS выбирает SMB1.
- **Пароль в `.env`** — это файл на диске, `chmod 600`. Альтернатива: файл с credentials на
  хосте (две строки `username=`/`password=`, `chmod 600`) и `credentials=/путь` вместо пары
  `username=,password=` в строке `o:` — читает его демон Docker, поэтому путь хостовый.
- **Прав на запись не нужно.** `ro` достаточно: `/Images/*` (обложки и файлы книг) на
  read-only коллекции работают.

Проверить, что шара смонтировалась:

```bash
docker compose exec api ls -la /library
```

### Если поиск по шаре тормозит

Поиск делает много случайных чтений `collection.db`, а SMB на таких чтениях медленный.
Лечится тем, что на шаре остаются только архивы, а коллекция копируется на локальный том:

```bash
docker volume create flibrary-web_collection
docker run --rm \
    -v flibrary-web_library:/library:ro \
    -v flibrary-web_collection:/collection \
    alpine cp /library/collection.db /collection/collection.db
```

и в `docker-compose.yml` у `api` и `opds` добавить том `collection:/collection:ro`, а
`COLLECTION_DB` указать на `/collection/collection.db`. Копию нужно обновлять после каждого
обновления коллекции — иначе будут находиться книги, которых в архивах уже нет.

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
  OPDS-каталог для читалок, смонтируйте `library:/library` без `:ro` **и** оставьте
  автообновление коллекции выключенным.
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
