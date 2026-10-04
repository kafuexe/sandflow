#!/bin/sh
# Example Script block: what this branch changed compared with BASE_BRANCH.
# Whatever it prints becomes the artifact (or write {"artifact": "…"} to $SANDFLOW_OUTPUT).
set -e
base="${BASE_BRANCH:-main}"
if git rev-parse --verify --quiet "origin/$base" >/dev/null; then ref="origin/$base"; else ref="$base"; fi
echo "# Changed files (vs $ref)"
echo
git diff --stat "$ref...HEAD"
