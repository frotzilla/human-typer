#!/usr/bin/env bash
# Builds two zips in dist/:
#   human-typer-<version>.zip           unzips to a human-typer/ folder you can Load unpacked
#   human-typer-<version>-webstore.zip  files at the zip root, for uploading to the Chrome Web Store
set -euo pipefail
cd "$(dirname "$0")"
version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
out="dist/human-typer-$version.zip"
stage=$(mktemp -d)
mkdir -p dist "$stage/human-typer"
cp -R manifest.json background.js content.js planner.js offscreen.html offscreen.js \
  popup.html popup.css popup.js icons README.md LICENSE "$stage/human-typer/"
store="dist/human-typer-$version-webstore.zip"
rm -f "$out" "$store"
(cd "$stage" && zip -qrX - human-typer -x '*.DS_Store') > "$out"
(cd "$stage/human-typer" && zip -qrX - . -x '*.DS_Store') > "$store"
rm -rf "$stage"
echo "$out"
echo "$store"
