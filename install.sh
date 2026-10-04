#!/bin/sh
# Install T3 Fleet: one file, run by Node 24 or newer.
#
#   curl -fsSL https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- setup <config-repo-url> <name>   # install, then run a command
#
# T3_FLEET_VERSION=v0.8.0 pins a release. The download is checked against the
# release's SHA256SUMS and, with gh installed and logged in, its build
# attestation; a mismatch or failed verification stops the install.
set -eu
repo="MartinPTielemans/fleetx"
version="${T3_FLEET_VERSION:-latest}"
dir="$HOME/.local/share/t3-fleet"
bin="$HOME/.local/bin"

command -v node >/dev/null 2>&1 || { echo "T3 Fleet needs Node 24 or newer; install it first (https://nodejs.org)" >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 24 ] || { echo "T3 Fleet needs Node 24 or newer; this is $(node --version)" >&2; exit 1; }

if [ "$version" = latest ]; then base="https://github.com/$repo/releases/latest/download"
else base="https://github.com/$repo/releases/download/$version"; fi

mkdir -p "$dir" "$bin"
tmp="$dir/t3-fleet.mjs.download"
name=t3-fleet.mjs
curl -fsSL "$base/$name" -o "$tmp"
fail() { rm -f "$tmp" "$tmp.sums"; echo "$1; not installing" >&2; exit 1; }

# The release's SHA256SUMS lists every file it ships.
if curl -fsSL "$base/SHA256SUMS" -o "$tmp.sums" 2>/dev/null; then
  want=$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$tmp.sums")
  rm -f "$tmp.sums"
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp" | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then got=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
  else got=""; fi
  if [ -z "$want" ]; then fail "SHA256SUMS has no entry for $name"
  elif [ -z "$got" ]; then echo "warning: no sha256sum or shasum to check the download with" >&2
  elif [ "$got" != "$want" ]; then fail "$name does not match the release's SHA256SUMS"
  else echo "checksum matches SHA256SUMS"; fi
else
  echo "warning: the release has no SHA256SUMS to check the download against" >&2
fi

# Not being able to verify (no gh, not logged in, gh too old, GitHub unreachable) is a
# warning; a verification that runs and fails stops the install.
if ! command -v gh >/dev/null 2>&1; then
  echo "note: install gh to verify the build attestation" >&2
elif ! gh auth status >/dev/null 2>&1; then
  echo "warning: gh is not logged in, so the build attestation was not verified" >&2
elif ! gh attestation verify --help >/dev/null 2>&1; then
  echo "warning: this gh is too old to verify build attestations (needs 2.49 or newer)" >&2
elif ! gh api rate_limit >/dev/null 2>&1; then
  echo "warning: GitHub is unreachable, so the build attestation was not verified" >&2
elif gh attestation verify "$tmp" --repo "$repo" >/dev/null 2>&1; then
  echo "verified build attestation"
else
  fail "$name failed build attestation verification"
fi
chmod 755 "$tmp" && mv "$tmp" "$dir/t3-fleet.mjs"
ln -sfn "$dir/t3-fleet.mjs" "$bin/t3-fleet"
echo "installed T3 Fleet $(node "$dir/t3-fleet.mjs" --version 2>/dev/null) at $bin/t3-fleet"
case ":$PATH:" in *":$bin:"*) ;; *) echo "add $bin to your PATH" ;; esac

[ $# -gt 0 ] && exec node "$dir/t3-fleet.mjs" "$@"
exit 0
