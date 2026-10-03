#!/usr/bin/env bash
# Refresh packages/core/src/vendor/t3 from a T3 Code checkout.
#   scripts/vendor-t3.sh /path/to/t3code
set -euo pipefail
src="${1:?usage: scripts/vendor-t3.sh /path/to/t3code}"
dest="$(cd "$(dirname "$0")/.." && pwd)/packages/core/src/vendor/t3"
rev="$(git -C "$src" rev-parse --short HEAD)"
for f in packages/contracts/src/baseSchemas.ts packages/contracts/src/environment.ts \
         packages/contracts/src/providerInstance.ts packages/shared/src/cliRelease.ts; do
  { printf '// Vendored from T3 Code (https://github.com/pingdotgg/t3code, MIT) at %s:%s.\n// Do not edit; refresh with scripts/vendor-t3.sh.\n' "$rev" "$f"
    cat "$src/$f"; } > "$dest/$(basename "$f")"
done
cp "$src/LICENSE" "$dest/LICENSE"
echo "vendored T3 Code $rev"
