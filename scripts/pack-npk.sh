#!/usr/bin/env bash
# Packs the unpacked Linux build (release/linux-unpacked) as an npack package
# (https://github.com/imattau/npack): a deterministic .npk plus its manifest.
#
# Usage: scripts/pack-npk.sh <version> <publisher npub-or-hex> [output dir]
#
# Needs `npack` on PATH. Writes <out>/ncc-browser-<version>-linux-x86_64.npk and
# <out>/ncc-browser-<version>-linux-x86_64.manifest.json.
set -euo pipefail

VERSION="${1:?usage: $0 VERSION PUBLISHER [OUTDIR]}"
PUBLISHER="${2:?usage: $0 VERSION PUBLISHER [OUTDIR]}"
OUT="${3:-release}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNPACKED="$ROOT/release/linux-unpacked"
[ -x "$UNPACKED/ncc-browser" ] || { echo "missing $UNPACKED/ncc-browser -- run npm run dist:linux first" >&2; exit 1; }

NAME=ncc-browser
# Electron derives the Linux WM_CLASS and Wayland app_id from
# app.setName('Nostr Navigator') (src/main/index.ts), so both are
# "nostr-navigator". The desktop file name and StartupWMClass must use that id:
# GNOME matches the Wayland app_id against the desktop id, and COSMIC matches
# it against the desktop id or StartupWMClass. A mismatch leaves the running
# window without a launcher, which shows up as the generic icon in the dock.
# electron-builder's deb/flatpak entries use the same id, so a system package
# and this npk share one launcher instead of adding a duplicate.
APP_ID=nostr-navigator
ARTIFACT="$NAME-$VERSION-linux-x86_64.npk"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/pkg"

npack init "$SRC" --name "$NAME" --version "$VERSION" --publisher "$PUBLISHER" >/dev/null

mkdir -p "$SRC/share" "$SRC/bin" "$SRC/share/applications" \
  "$SRC/share/icons/hicolor/128x128/apps" \
  "$SRC/share/icons/hicolor/256x256/apps" \
  "$SRC/share/icons/hicolor/512x512/apps"
cp -a "$UNPACKED" "$SRC/share/$NAME"
ln -s "../share/$NAME/$NAME" "$SRC/bin/$NAME"
for size in 128 256 512; do
  cp "$ROOT/build/icons/${size}x${size}.png" "$SRC/share/icons/hicolor/${size}x${size}/apps/$NAME.png"
done

# {{prefix}} is filled in by npack with the install location (listed in templates.txt).
# Icon names are resolved by the theme (hicolor) into the sizes installed above;
# both GTK/GNOME and COSMIC fall back to the closest size, so 256px alone would
# work, and no icon-cache refresh is needed. Quote Exec because the user prefix
# is under $HOME, which may contain spaces.
cat > "$SRC/share/applications/$APP_ID.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Nostr Navigator
Comment=Browse Nostr identity services without DNS
Exec="{{prefix}}/bin/$NAME" %U
TryExec={{prefix}}/bin/$NAME
Icon=$NAME
Terminal=false
Categories=Network;WebBrowser;
MimeType=x-scheme-handler/ncc;x-scheme-handler/http;x-scheme-handler/https;text/html;application/xhtml+xml;
StartupNotify=true
StartupWMClass=$APP_ID
DESKTOP
echo "share/applications/$APP_ID.desktop" > "$SRC/.npack/templates.txt"

python3 - "$SRC/.npack/manifest.json" "$VERSION" "$APP_ID" <<'PY'
import json, sys
path, version, app_id = sys.argv[1:]
with open(path) as f:
    m = json.load(f)
m["app"] = {
    "summary": "Browse Nostr identity services without DNS",
    "description": "Nostr Navigator resolves ncc://<npub>/<service> through NCC-05 locators and renders the service bound to that Nostr identity.",
    "homepage": "https://github.com/imattau/ncc-browser",
    "license": "MIT",
    "categories": ["Network", "WebBrowser"],
    "icon": f"share/icons/hicolor/256x256/apps/{m['name']}.png",
    "desktop_file": f"share/applications/{app_id}.desktop",
    "support_url": "https://github.com/imattau/ncc-browser/issues",
}
with open(path, "w") as f:
    json.dump(m, f, indent=2)
    f.write("\n")
PY

mkdir -p "$OUT"
npack pack "$SRC" --output "$OUT/$ARTIFACT"
npack manifest "$OUT/$ARTIFACT" --output "$OUT/${ARTIFACT%.npk}.manifest.json"
npack verify "$OUT/${ARTIFACT%.npk}.manifest.json"
echo "packed $OUT/$ARTIFACT"
