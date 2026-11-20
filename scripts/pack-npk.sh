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
ARTIFACT="$NAME-$VERSION-linux-x86_64.npk"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SRC="$WORK/pkg"

npack init "$SRC" --name "$NAME" --version "$VERSION" --publisher "$PUBLISHER" >/dev/null

mkdir -p "$SRC/share" "$SRC/bin" "$SRC/share/applications" "$SRC/share/icons/hicolor/256x256/apps"
cp -a "$UNPACKED" "$SRC/share/$NAME"
ln -s "../share/$NAME/$NAME" "$SRC/bin/$NAME"
cp "$ROOT/build/icons/256x256.png" "$SRC/share/icons/hicolor/256x256/apps/$NAME.png"

# {{prefix}} is filled in by npack with the install location (listed in templates.txt).
cat > "$SRC/share/applications/$NAME.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Nostr Navigator
Comment=Browse Nostr identity services without DNS
Exec={{prefix}}/bin/$NAME %U
# Use the installed icon's absolute path. Some GNOME installations do not
# refresh the hicolor icon cache when npack installs into a user prefix, so
# resolving the theme name alone can leave the launcher with a generic icon.
Icon={{prefix}}/share/icons/hicolor/256x256/apps/$NAME.png
Terminal=false
Categories=Network;WebBrowser;
MimeType=x-scheme-handler/ncc;
# Electron exposes the executable's WM_CLASS on Linux, not the display name.
StartupWMClass=$NAME
DESKTOP
echo "share/applications/$NAME.desktop" > "$SRC/.npack/templates.txt"

python3 - "$SRC/.npack/manifest.json" "$VERSION" <<'PY'
import json, sys
path, version = sys.argv[1:]
with open(path) as f:
    m = json.load(f)
m["app"] = {
    "summary": "Browse Nostr identity services without DNS",
    "description": "Nostr Navigator resolves ncc://<npub>/<service> through NCC-05 locators and renders the service bound to that Nostr identity.",
    "homepage": "https://github.com/imattau/ncc-browser",
    "license": "MIT",
    "categories": ["Network", "WebBrowser"],
    "icon": f"share/icons/hicolor/256x256/apps/{m['name']}.png",
    "desktop_file": f"share/applications/{m['name']}.desktop",
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
