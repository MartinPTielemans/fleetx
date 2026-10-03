#!/bin/sh
# Install fleetx: one file, run by Node 24 or newer.
#
#   curl -fsSL https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- join <config-repo-url> <name>    # install, then run a command
#
# FLEETX_VERSION=v0.2.0 pins a release. With gh installed, the download is
# checked against the release's build attestation before it is installed.
set -eu
repo="MartinPTielemans/fleetx"
version="${FLEETX_VERSION:-latest}"
dir="$HOME/.local/share/fleetx"
bin="$HOME/.local/bin"

command -v node >/dev/null 2>&1 || { echo "fleetx needs Node 24 or newer; install it first (https://nodejs.org)" >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "fleetx needs Node 24 or newer; this is $(node --version)" >&2; exit 1; }

if [ "$version" = latest ]; then url="https://github.com/$repo/releases/latest/download/fleetx.mjs"
else url="https://github.com/$repo/releases/download/$version/fleetx.mjs"; fi

mkdir -p "$dir" "$bin"
tmp="$dir/fleetx.mjs.download"
curl -fsSL "$url" -o "$tmp"
if command -v gh >/dev/null 2>&1; then
  if gh attestation verify "$tmp" --repo "$repo" >/dev/null 2>&1; then echo "verified build attestation"
  else echo "warning: could not verify the build attestation (offline, or gh not logged in)" >&2; fi
fi
chmod 755 "$tmp" && mv "$tmp" "$dir/fleetx.mjs"
ln -sfn "$dir/fleetx.mjs" "$bin/fleetx"
echo "installed fleetx $(node "$dir/fleetx.mjs" --version 2>/dev/null) at $bin/fleetx"
case ":$PATH:" in *":$bin:"*) ;; *) echo "add $bin to your PATH" ;; esac

[ $# -gt 0 ] && exec node "$dir/fleetx.mjs" "$@"
exit 0
