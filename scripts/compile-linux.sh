#!/usr/bin/env bash
# Build the Sandflow Linux installers (.AppImage + .tar.gz) into release/.
#
# Usage: scripts/compile-linux.sh [--image]
#   --image   also build the offline sandbox image bundle (needs Docker)
set -euo pipefail

cd "$(dirname "$0")/.."

BUILD_IMAGE=0
for arg in "$@"; do
  case "$arg" in
    --image) BUILD_IMAGE=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required (https://nodejs.org)." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22+ is required (found $(node --version))." >&2
  exit 1
fi

VERSION="$(node -p 'require("./package.json").version')"
echo "==> Building Sandflow $VERSION for Linux"

echo "==> Installing dependencies"
npm ci

echo "==> Building the app and installers"
npm run app:dist -- --linux

if [ "$BUILD_IMAGE" -eq 1 ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker is required for --image." >&2
    exit 1
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
  esac
  echo "==> Building the offline sandbox image (linux/$ARCH)"
  docker build -t "sandflow-agent:$VERSION" sandbox
  FILE="release/sandflow-sandbox-image-$VERSION-linux-$ARCH.tar.gz"
  docker save "sandflow-agent:$VERSION" | gzip -9 > "$FILE"
  (cd release && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256")
fi

echo
echo "==> Done. Output in release/:"
ls -1 release | grep -E '\.(AppImage|tar\.gz|sha256)$' || true
