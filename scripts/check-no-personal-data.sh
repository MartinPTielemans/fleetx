#!/usr/bin/env bash
# The engine is public and generic: nothing about one user's machines may be
# committed to it. Add a pattern here whenever a new kind of detail could leak.
# Run by `pnpm test` and CI. FLEETX_PRIVATE_PATTERNS adds your own, locally.
set -euo pipefail
cd "$(dirname "$0")/.."
patterns='/Users/[a-z]{2,}|/home/[a-z]{2,}/|\.ts\.net\b|tail[0-9a-f]{6}\b|\b(api_key|apiKey|token)\s*[:=]\s*"[A-Za-z0-9_-]{20,}'
[ -n "${FLEETX_PRIVATE_PATTERNS:-}" ] && patterns="$patterns|$FLEETX_PRIVATE_PATTERNS"
# server.tailnet.ts.net is the placeholder host docs and comments use.
hits="$(git grep -nIE "$patterns" -- . ':!packages/core/src/vendor' ':!pnpm-lock.yaml' ':!LICENSE' ':!scripts/check-no-personal-data.sh' | grep -v 'tailnet\.ts\.net' || true)"
if [ -n "$hits" ]; then
  echo "Personal or machine-specific data in the engine:" >&2
  printf '%s\n' "$hits" >&2
  exit 1
fi
echo "no personal data"
