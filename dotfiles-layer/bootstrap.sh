#!/bin/sh
set -eu

PACKAGE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "dotfiles-layer: Node.js 22+ and npm are required" >&2
  exit 1
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "dotfiles-layer: Node.js 22+ is required (found $(node --version))" >&2
  exit 1
fi

LOCK_FILE=$PACKAGE_DIR/package-lock.json
STAMP_FILE=$PACKAGE_DIR/node_modules/.dotfiles-layer-lock.sha256

if [ ! -f "$LOCK_FILE" ]; then
  echo "dotfiles-layer: missing package-lock.json" >&2
  exit 1
fi
LOCK_HASH=$(node -e 'const fs=require("node:fs"),crypto=require("node:crypto"); process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$LOCK_FILE")
if [ -d "$PACKAGE_DIR/node_modules" ] && [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE")" = "$LOCK_HASH" ]; then
  echo "dotfiles-layer dependencies are current."
  exit 0
fi

cd "$PACKAGE_DIR"
npm ci --ignore-scripts
printf '%s\n' "$LOCK_HASH" > "$STAMP_FILE"
echo "Installed dotfiles-layer dependencies."
