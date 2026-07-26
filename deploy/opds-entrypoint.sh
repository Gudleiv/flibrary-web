#!/bin/sh
# Запуск C++-сервера FLibrary в контейнере: конфиг коллекции, headless-компоситор, opds.
set -eu

conf="$HOME/.config/HomeCompa/FLibrary.conf"

# Коллекцию регистрируем конфигом, а не аргументами `opds --name --database --archives`:
# на уже существующей коллекции эти аргументы пересоздают её пустой (проверено на 2.6.6:
# 5000 книг превратились в 0). Без аргументов opds просто открывает то, что записано здесь.
#
# AutoupdateCollection=false — на всякий случай: автообновлять коллекцию без inpx нечем,
# а том с коллекцией смонтирован read-only.
#
# Ключ группы (`flibrary`) — произвольный идентификатор, десктоп генерирует хеш, но opds
# берёт ту группу, на которую указывает `current`.
mkdir -p "$(dirname "$conf")"
cat > "$conf" <<EOF
[Collections]
flibrary\\name=${COLLECTION_NAME}
flibrary\\database=${COLLECTION_DB}
flibrary\\folder=${ARCHIVES_DIR}
flibrary\\additional=${ADDITIONAL_DIR:-}
flibrary\\creationMode=0
flibrary\\destructiveOperationsAllowed=false
flibrary\\discardedUpdate=
current=flibrary

[Preferences]
opds\\AutoupdateCollection=false
EOF

if [ ! -r "$COLLECTION_DB" ]; then
    echo "opds: не читается $COLLECTION_DB — проверьте том с коллекцией" >&2
    exit 1
fi
if [ ! -d "$ARCHIVES_DIR" ]; then
    echo "opds: нет каталога с архивами $ARCHIVES_DIR" >&2
    exit 1
fi

# opds линкует Qt Gui (ему нужны картинки), поэтому без платформенного плагина он не
# стартует, а offscreen в портативной сборке отсутствует — см. комментарий в opds.Dockerfile.
# Отсюда weston: headless-бэкенд не требует ни GPU, ни устройств ввода.
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
weston --backend=headless --socket="$WAYLAND_DISPLAY" --idle-time=0 &

waited=0
while [ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; do
    waited=$((waited + 1))
    if [ "$waited" -gt 100 ]; then
        echo "opds: weston не поднял сокет $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" >&2
        exit 1
    fi
    sleep 0.1
done

exec /opt/flibrary/opds "$@"
