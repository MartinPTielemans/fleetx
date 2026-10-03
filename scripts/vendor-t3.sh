#!/usr/bin/env bash
# Refresh packages/core/src/vendor/t3 from a T3 Code checkout.
#   scripts/vendor-t3.sh /path/to/t3code
set -euo pipefail
src="${1:?usage: scripts/vendor-t3.sh /path/to/t3code}"
dest="$(cd "$(dirname "$0")/.." && pwd)/packages/core/src/vendor/t3"
rev="$(git -C "$src" rev-parse --short HEAD)"
# server.ts carries ServerProvider (the provider snapshot T3 serves from
# server.getConfig); the contracts after it are what server.ts imports.
contracts="baseSchemas environment providerInstance server acpRegistry auth browserProfile \
  chatAttachment device editor keybindings model modelSelection preview project providerPolicy \
  providerUsageLimits pullRequest settings sourceControl usageLimitSourceId vcs"
files="packages/shared/src/cliRelease.ts"
for c in $contracts; do files="$files packages/contracts/src/$c.ts"; done
for f in $files; do
  { printf '// Vendored from T3 Code (https://github.com/pingdotgg/t3code, MIT) at %s:%s.\n// Do not edit; refresh with scripts/vendor-t3.sh.\n' "$rev" "$f"
    cat "$src/$f"; } > "$dest/$(basename "$f")"
done
cp "$src/LICENSE" "$dest/LICENSE"
echo "vendored T3 Code $rev"
