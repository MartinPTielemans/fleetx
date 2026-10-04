#!/bin/sh
# Install T3 Fleet: one file, run by Node 24 or newer.
#
#   curl -fsSL https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- join <config-repo-url> <name>    # install, then run a command
#
# T3_FLEET_VERSION=v0.5.0 pins a release (FLEETX_VERSION still works). With gh
# installed, the download is checked against the release's build attestation
# before it is installed. `fleetx` is installed too, as another name for
# `t3-fleet`, until 1.0.
set -eu
repo="MartinPTielemans/fleetx"
version="${T3_FLEET_VERSION:-${FLEETX_VERSION:-latest}}"
dir="$HOME/.local/share/t3-fleet"
bin="$HOME/.local/bin"

command -v node >/dev/null 2>&1 || { echo "T3 Fleet needs Node 24 or newer; install it first (https://nodejs.org)" >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "T3 Fleet needs Node 24 or newer; this is $(node --version)" >&2; exit 1; }

if [ "$version" = latest ]; then base="https://github.com/$repo/releases/latest/download"
else base="https://github.com/$repo/releases/download/$version"; fi

mkdir -p "$dir" "$bin"
tmp="$dir/t3-fleet.mjs.download"
# Releases before the rename have the bundle only as fleetx.mjs.
curl -fsSL "$base/t3-fleet.mjs" -o "$tmp" 2>/dev/null || curl -fsSL "$base/fleetx.mjs" -o "$tmp"
if command -v gh >/dev/null 2>&1; then
  if gh attestation verify "$tmp" --repo "$repo" >/dev/null 2>&1; then echo "verified build attestation"
  else echo "warning: could not verify the build attestation (offline, or gh not logged in)" >&2; fi
fi
chmod 755 "$tmp" && mv "$tmp" "$dir/t3-fleet.mjs"
ln -sfn "$dir/t3-fleet.mjs" "$bin/t3-fleet"
ln -sfn "$dir/t3-fleet.mjs" "$bin/fleetx"
echo "installed T3 Fleet $(node "$dir/t3-fleet.mjs" --version 2>/dev/null) at $bin/t3-fleet"
case ":$PATH:" in *":$bin:"*) ;; *) echo "add $bin to your PATH" ;; esac

[ $# -gt 0 ] && exec node "$dir/t3-fleet.mjs" "$@"
exit 0
