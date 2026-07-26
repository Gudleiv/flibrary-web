# Внутренний content-service: C++-сервер FLibrary (`opds`) — обложки, файлы книг,
# конвертеры форматов.
#
# Из исходников не собираем: это Qt 6.10+ и зависимости Conan, часы сборки. Берём
# официальную портативную сборку релиза — в ней уже лежат `opds`, Qt 6.11 и `7z.so`.
#
# Три неочевидных вещи, все проверены на 2.6.6 (подробнее — docs/deploy.md):
#
#  1. В портативной сборке нет QPA-плагина `offscreen`, а плагины QPA грузятся только при
#     совпадении major.minor Qt («Ignoring QPA plugin due to mismatching Qt versions»), так
#     что подложить offscreen из пакетов дистрибутива нельзя: в Ubuntu Qt 6.10, в сборке
#     6.11. Из headless-вариантов остаётся `wayland` (плагин в сборке есть) плюс weston с
#     headless-бэкендом. `xcb` не годится тоже: в сборке нет libQt6XcbQpa.
#  2. Бинарник собран gcc 16, ему нужен libstdc++ с GLIBCXX_3.4.35. В Ubuntu 26.04 такой
#     штатный, в 24.04 — нет, поэтому база именно 26.04.
#  3. Коллекция регистрируется через QSettings-конфиг, а не аргументами командной строки:
#     `--database/--archives` на существующей коллекции пересоздают её пустой.

FROM ubuntu:26.04

# Версия и ссылка на релиз. Тег в upstream выглядит как `Release/2/<версия>`.
ARG FLIBRARY_VERSION=2.6.6
ARG FLIBRARY_URL=https://github.com/heimdallr/books/releases/download/Release/2/${FLIBRARY_VERSION}/FLibrary-${FLIBRARY_VERSION}-portable-Linux.tar.xz

# Список собран по ldd всех библиотек и плагинов портативной сборки: своё Qt она приносит,
# а системные зависимости Qt — нет.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates curl xz-utils \
        weston \
        libstdc++6 libatomic1 \
        libegl1 libopengl0 libglvnd0 libglx0 \
        libwayland-client0 libwayland-cursor0 libxkbcommon0 libx11-6 libxcb1 \
        libglib2.0-0t64 libdbus-1-3 libpcre2-16-0 \
        libfontconfig1 libfreetype6 libharfbuzz0b \
        libjpeg-turbo8 libtiff6 libwebp7 libwebpmux3 liblerc4 libdeflate0 libjbig0 \
        libsharpyuv0 libbz2-1.0 \
    && rm -rf /var/lib/apt/lists/*

RUN curl --fail --location --silent --show-error "${FLIBRARY_URL}" -o /tmp/flibrary.tar.xz \
    && mkdir -p /opt/flibrary \
    && tar --extract --xz --file /tmp/flibrary.tar.xz --directory /opt/flibrary --strip-components=1 \
    && rm /tmp/flibrary.tar.xz \
    && test -x /opt/flibrary/opds

COPY opds-entrypoint.sh /usr/local/bin/opds-entrypoint.sh
RUN chmod +x /usr/local/bin/opds-entrypoint.sh

# LC_ALL: Qt и сам переключается на C.UTF-8, но имена файлов в архивах русские — лучше явно.
# HOME: QSettings пишет конфиг в $HOME/.config/HomeCompa/FLibrary.conf.
ENV LD_LIBRARY_PATH=/opt/flibrary/lib \
    ICU_DATA=/opt/flibrary/lib \
    LC_ALL=C.UTF-8 \
    QT_QPA_PLATFORM=wayland \
    WAYLAND_DISPLAY=wayland-0 \
    XDG_RUNTIME_DIR=/run/opds \
    HOME=/var/lib/flibrary-opds \
    COLLECTION_NAME=collection \
    COLLECTION_DB=/library/collection.db \
    ARCHIVES_DIR=/library/archives

EXPOSE 12791

# `/` — вшитая в бинарник SPA, она отдаётся без обращения к коллекции: это проверка того,
# что процесс жив, а не того, что коллекция на месте.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD curl --fail --silent --output /dev/null http://127.0.0.1:12791/

ENTRYPOINT ["/usr/local/bin/opds-entrypoint.sh"]
