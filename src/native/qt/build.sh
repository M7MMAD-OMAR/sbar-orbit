#!/bin/sh
set -eu
# A matching Qt development sysroot can be supplied without installing packages.
qt_sysroot=${ORBIT_QT_SYSROOT:-}
qt_include=${qt_sysroot}/usr/include/qt6
output=${1:?output shared library path required}
source_path=$(realpath "$(dirname "$0")/widget_bridge.cpp")
build_dir=$(mktemp -d "$(dirname "$output")/.orbit-qt-build.XXXXXX")
trap 'rm -rf "$build_dir"' EXIT HUP INT TERM
cp "$source_path" "$build_dir/widget_bridge.cpp"
c++ -std=c++20 -O2 -fPIC -shared -Wall -Wextra -Werror \
  -I"$qt_include" -I"$qt_include/QtCore" -I"$qt_include/QtGui" \
  -I"$qt_include/QtWidgets" -I"$qt_include/QtDBus" \
  "$build_dir/widget_bridge.cpp" -l:libQt6Widgets.so.6 -l:libQt6Gui.so.6 -l:libQt6DBus.so.6 -l:libQt6Core.so.6 -o "$build_dir/liborbit-qt-widget.so"
bun -e 'const [source, copied, library] = process.argv.slice(1); const digest = async path => new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex"); const sourceHash = await digest(copied); if (sourceHash !== await digest(source)) throw new Error("Qt bridge source changed during build"); await Bun.write(library + ".source.json", JSON.stringify({schema:1,sourceSha256:sourceHash,librarySha256:await digest(library)}));' "$source_path" "$build_dir/widget_bridge.cpp" "$build_dir/liborbit-qt-widget.so"
# Replace the inode, never truncate a helper mapped by an existing application.
mv "$build_dir/liborbit-qt-widget.so" "$output"
mv "$build_dir/liborbit-qt-widget.so.source.json" "$output.source.json"
