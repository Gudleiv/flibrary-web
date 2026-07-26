#!/usr/bin/env bash
# Локальный content-service: тот же C++-сервер FLibrary, что и в проде, но без Docker.
#
# Нужен, чтобы обложки и скачивание книг работали в разработке: без него эти ручки отдают
# 502, и проверить их нечем. Из исходников ничего не собирается — берётся официальная
# портативная сборка релиза (в ней уже есть opds, Qt и 7z.so).
#
#   scripts/opds-local.sh                 # коллекция и архивы из data/ (фикстуры)
#   scripts/opds-local.sh --database /srv/library/collection.db --archives /srv/library/archives
#   scripts/opds-local.sh --stop
#
# Требования: weston (apt install weston) — почему именно он, объяснено в
# deploy/opds.Dockerfile. Всё скачанное складывается в data/opds и не коммитится.

set -euo pipefail

version="${FLIBRARY_VERSION:-2.6.6}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$repo_root/data/opds"
dist="$work/FLibrary-$version"
home="$work/home"
runtime="$work/run"

database="$repo_root/data/collection.db"
archives="$repo_root/data/archives"
name="collection"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --database) database="$2"; shift 2 ;;
        --archives) archives="$2"; shift 2 ;;
        --name) name="$2"; shift 2 ;;
        --stop)
            pkill -x opds && echo "opds остановлен" || echo "opds не запущен"
            pkill -f "weston --backend=headless --socket=flibrary-local" >/dev/null 2>&1 || true
            exit 0
            ;;
        *) echo "неизвестный аргумент: $1" >&2; exit 2 ;;
    esac
done

command -v weston >/dev/null || {
    echo "нет weston: opds линкует Qt Gui и без платформенного плагина не стартует," >&2
    echo "а offscreen в портативной сборке отсутствует. Поставьте: apt install weston" >&2
    exit 1
}
# Своё Qt портативная сборка приносит, системные зависимости Qt — нет.
for lib in libOpenGL.so.0 libEGL.so.1; do
    ldconfig -p 2>/dev/null | grep -q "$lib " || {
        echo "нет $lib. Поставьте: apt install libegl1 libopengl0" >&2
        exit 1
    }
done
[[ -f "$database" ]] || { echo "нет коллекции $database (pnpm fixtures)" >&2; exit 1; }
[[ -d "$archives" ]] || { echo "нет архивов $archives (pnpm fixtures без --no-archives)" >&2; exit 1; }

mkdir -p "$work" "$runtime" "$home/.config/HomeCompa"

if [[ ! -x "$dist/opds" ]]; then
    url="https://github.com/heimdallr/books/releases/download/Release/2/$version/FLibrary-$version-portable-Linux.tar.xz"
    echo "качаю FLibrary $version"
    mkdir -p "$dist"
    curl --fail --location --progress-bar "$url" | tar --extract --xz --directory "$dist" --strip-components=1
fi

# Сборка релиза сделана gcc 16, поэтому нужен libstdc++ с GLIBCXX_3.4.35. В Ubuntu 26.04 он
# штатный, на 24.04 (в том числе в облачной сессии) — нет, и тогда достаточно распаковать
# рядом рантайм gcc-16, не трогая системный: LD_LIBRARY_PATH ниже ставит его первым.
extra_lib=""
system_libstdcxx="$(ldconfig -p 2>/dev/null | awk '/libstdc\+\+\.so\.6 /{print $NF; exit}')"
if [[ -z "$system_libstdcxx" ]] || ! grep -aq "GLIBCXX_3\.4\.35" "$system_libstdcxx"; then
    if [[ ! -f "$work/rt/libstdc++.so.6" ]]; then
        echo "системному libstdc++ не хватает GLIBCXX_3.4.35, распаковываю рантайм gcc-16"
        deb="${LIBSTDCXX_DEB:-https://archive.ubuntu.com/ubuntu/pool/main/g/gcc-16/libstdc++6_16.1.0-3ubuntu1_amd64.deb}"
        mkdir -p "$work/deb" "$work/rt"
        curl --fail --location --silent --show-error "$deb" -o "$work/deb/libstdc++6.deb"
        dpkg -x "$work/deb/libstdc++6.deb" "$work/deb/x"
        cp "$work/deb"/x/usr/lib/x86_64-linux-gnu/libstdc++.so.6* "$work/rt/"
    fi
    extra_lib=":$work/rt"
fi

# Коллекция регистрируется конфигом: аргументы --database/--archives на существующей
# коллекции пересоздают её пустой (проверено на 2.6.6).
cat > "$home/.config/HomeCompa/FLibrary.conf" <<EOF
[Collections]
flibrary\\name=$name
flibrary\\database=$database
flibrary\\folder=$archives
flibrary\\additional=
flibrary\\creationMode=0
flibrary\\destructiveOperationsAllowed=false
flibrary\\discardedUpdate=
current=flibrary

[Preferences]
opds\\AutoupdateCollection=false
EOF

chmod 700 "$runtime"
if [[ ! -S "$runtime/flibrary-local" ]]; then
    XDG_RUNTIME_DIR="$runtime" weston --backend=headless --socket=flibrary-local --idle-time=0 \
        > "$work/weston.log" 2>&1 &
    for _ in $(seq 100); do [[ -S "$runtime/flibrary-local" ]] && break; sleep 0.1; done
fi
[[ -S "$runtime/flibrary-local" ]] || { echo "weston не поднялся, лог: $work/weston.log" >&2; exit 1; }

echo "opds на http://127.0.0.1:12791 (коллекция $database)"
cd "$dist"
HOME="$home" \
XDG_RUNTIME_DIR="$runtime" \
WAYLAND_DISPLAY=flibrary-local \
QT_QPA_PLATFORM=wayland \
ICU_DATA="$dist/lib" \
LC_ALL=C.UTF-8 \
LD_LIBRARY_PATH="$dist/lib$extra_lib" \
    exec ./opds
