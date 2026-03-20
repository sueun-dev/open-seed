#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$DIR/.electron-bin/electron-pkg/dist/Electron.app/Contents/MacOS/Electron"
exec "$ELECTRON" "$DIR" "$@"
