#!/usr/bin/env bash
# End-to-end test on throwaway containers: init on laptop, invite and join
# server and desktop, check them over ssh, sync, propose and approve. Desktop
# runs the last release (0.7.1) until laptop installs this build there, so a
# fleet in the middle of an upgrade is covered too.
# Usage: tests/integration/run.sh   (needs Docker and network; builds the bundle first)
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=t3-fleet-it
pass() { printf '\033[32mpass\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
on() { local node=$1; shift; docker compose exec -T -u dev "$node" bash -lc "export PATH=\$HOME/.local/bin:\$PATH; $*"; }
# expect NODE PATTERN COMMAND: run COMMAND on NODE, fail with its output unless it matches PATTERN.
expect() {
  local node=$1 pattern=$2; shift 2
  local out; out=$(on "$node" "$*" 2>&1) || true
  printf '%s' "$out" | grep -q -- "$pattern" || fail "$node: $* (wanted /$pattern/):
$out"
}

old=0.7.1
release=$(mktemp -d)
trap 'docker compose down -v -t 1 >/dev/null 2>&1; rm -rf "$release"' EXIT
(cd ../.. && pnpm --filter t3-fleet build >/dev/null)
base="https://github.com/MartinPTielemans/fleetx/releases/download/v$old"
curl -fsSL "$base/t3-fleet.mjs" -o "$release/t3-fleet.mjs" && curl -fsSL "$base/SHA256SUMS" -o "$release/SHA256SUMS" \
  || fail "could not download T3 Fleet $old"
(cd "$release" && grep ' t3-fleet.mjs$' SHA256SUMS | sha256sum -c --quiet -) || fail "T3 Fleet $old does not match its SHA256SUMS"
docker compose up -d --build --quiet-pull >/dev/null 2>&1

# ssh between nodes as dev, with one shared key; a git identity everywhere.
docker compose exec -T laptop bash -c 'ssh-keygen -q -t ed25519 -N "" -f /keys/id && chmod 644 /keys/id*' >/dev/null
for n in laptop server desktop; do
  docker compose exec -T "$n" bash -c '
    install -o dev -g dev -m 600 /keys/id /home/dev/.ssh/id_ed25519
    install -o dev -g dev -m 644 /keys/id.pub /home/dev/.ssh/authorized_keys
    printf "Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n" > /home/dev/.ssh/config && chown dev /home/dev/.ssh/config
    mkdir -p /home/dev/.local/bin && ln -sf /t3-fleet/bin.mjs /home/dev/.local/bin/t3-fleet && chown -R dev:dev /home/dev/.local
    chown dev:dev /srv/remote'
  on "$n" 'git config --global user.name dev && git config --global user.email dev@example.com && git config --global init.defaultBranch main'
done
# Desktop has the last release installed, as install.sh leaves it.
docker compose cp "$release/t3-fleet.mjs" desktop:/tmp/t3-fleet.mjs >/dev/null 2>&1
on desktop 'mkdir -p ~/.local/share/t3-fleet && install -m 755 /tmp/t3-fleet.mjs ~/.local/share/t3-fleet/t3-fleet.mjs && ln -sfn ~/.local/share/t3-fleet/t3-fleet.mjs ~/.local/bin/t3-fleet'
on desktop 't3-fleet --version' | grep -q "^t3-fleet v$old" || fail "desktop should run $old: $(on desktop 't3-fleet --version')"

# A skill to discover, then init.
on laptop 'mkdir -p ~/.agents/skills/demo && printf -- "---\nname: demo\ndescription: d\n---\nhi\n" > ~/.agents/skills/demo/SKILL.md'
expect laptop "Created" 't3-fleet init --repo ~/fleet'
on laptop 'grep -q "timer = true" ~/fleet/t3-fleet.toml && sed -i "s/timer = true/timer = false/" ~/fleet/t3-fleet.toml && git -C ~/fleet commit -qam "No timers in tests"'
on laptop 'git init -q --bare /srv/remote/fleet.git && git -C ~/fleet remote add origin /srv/remote/fleet.git && git -C ~/fleet push -q -u origin main'
pass "init on laptop, pushed to the shared remote"

for n in server desktop; do
  expect laptop "join /srv/remote/fleet.git $n" "t3-fleet invite $n"
  out=$(on "$n" "t3-fleet join /srv/remote/fleet.git $n" 2>&1) || true; printf "%s" "$out" | grep -q "Joined as $n" || fail "join $n: $out"
done
pass "invite and join server and desktop"

out=$(on laptop 't3-fleet status --json')
[ "$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.results.filter(x=>x.ok).length)})')" = 3 ] || fail "status should observe 3 nodes: $out"
pass "status observes all three nodes (two over ssh, one of them on $old)"

on laptop 't3-fleet sync' >/dev/null || true
on server 't3-fleet sync' >/dev/null || true
on laptop 't3-fleet secrets set TEST_SECRET=hello' >/dev/null
on desktop 't3-fleet sync' >/dev/null || true
expect laptop "synced" 't3-fleet sync'
on desktop 't3-fleet sync' >/dev/null || true
[ "$(on desktop 'grep -c TEST_SECRET ~/.config/t3-fleet/secrets.env')" = 1 ] || fail "desktop should have the secret after the authority added its key"
pass "an authority's sync lets joined nodes read the secrets"

refs=$(on laptop 'git ls-remote /srv/remote/fleet.git')
for n in laptop server desktop; do
  printf '%s' "$refs" | grep -q "refs/heads/t3-fleet/state/$n" || fail "$n should publish its state on t3-fleet/state/$n: $refs"
done
pass "every node, $old too, publishes its state on t3-fleet/state"

on desktop 'mkdir -p ~/fleet/skills/proposed && printf -- "---\nname: proposed\ndescription: p\n---\nx\n" > ~/fleet/skills/proposed/SKILL.md'
expect desktop "proposed 1 file" 't3-fleet sync'
expect laptop "desktop" 't3-fleet review'
expect laptop "approved" 't3-fleet approve desktop'
on desktop 't3-fleet sync' >/dev/null
[ -z "$(on desktop 'git -C ~/fleet status --porcelain')" ] || fail "desktop should be clean after its approved proposal came back"
pass "propose (from $old), review, approve, and the change returns cleanly"

expect laptop "3 environments" 't3-fleet status --all'
pass "status --all reads every node's published state, $old's too"

# Skills from a git source, with provenance, reaching another node.
on laptop 'mkdir -p /tmp/src/tools/vendored && cd /tmp/src && git init -q && printf -- "---\nname: vendored\ndescription: v\n---\nv1\n" > tools/vendored/SKILL.md && git add -A && git commit -qm v1 && git clone -q --bare /tmp/src /srv/remote/skills.git'
expect laptop "added vendored: committed" 't3-fleet skills add /srv/remote/skills.git'
expect laptop '"tools/vendored"' 'cat ~/fleet/skills/SOURCES.json'
on server 't3-fleet sync' >/dev/null || true
expect server "vendored" 'ls -la ~/.agents/skills/'
pass "skills add vendors with provenance, and nodes link it on sync"

on laptop 'cd /tmp/src && printf -- "---\nname: vendored\ndescription: v\n---\nv2\n" > tools/vendored/SKILL.md && git commit -qam v2 && git push -q /srv/remote/skills.git HEAD:main 2>/dev/null || git push -q /srv/remote/skills.git HEAD'
expect laptop "committed and pushed" 't3-fleet skills update --yes'
expect laptop "v2" 'cat ~/fleet/skills/vendored/SKILL.md'
pass "skills update re-pulls from the source"

# The MCP server starts and lists its tools (an invalid tool schema stops it at startup).
expect laptop "fleet_alerts" "printf '%s\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"clientInfo\":{\"name\":\"t\",\"version\":\"1\"}}}' '{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}' '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}' | (cat; sleep 4) | t3-fleet mcp"
pass "the MCP server starts and lists its tools"

# Installing this build over the last release, as `t3-fleet fix` does after an upgrade.
expect laptop "older build ($old built" 't3-fleet status --node desktop'
expect laptop "installed T3 Fleet" 't3-fleet fix --yes --area engine --node desktop'
[ "$(on desktop 't3-fleet --version')" = "$(on laptop 't3-fleet --version')" ] || fail "desktop should have the controller's build: $(on desktop 't3-fleet --version')"
on laptop 't3-fleet status --node desktop' | grep -q "engine" && fail "no engine finding should remain on desktop: $(on laptop 't3-fleet status --node desktop')"
expect desktop "synced" 't3-fleet sync'
pass "fix installs the controller's build over $old, which then syncs"

# Installing the build on a member that has none.
on server 'rm -f ~/.local/bin/t3-fleet'
expect laptop "T3 Fleet is not installed here" 't3-fleet status --node server'
expect laptop "installed T3 Fleet" 't3-fleet fix --yes --area engine --node server'
[ "$(on server 'readlink ~/.local/bin/t3-fleet')" = "$(on server 'echo ~/.local/share/t3-fleet/t3-fleet.mjs')" ] || fail "server should run the installed copy"
[ "$(on server 't3-fleet --version')" = "$(on laptop 't3-fleet --version')" ] || fail "server should have the controller's build: $(on server 't3-fleet --version')"
on laptop 't3-fleet status --node server' | grep -q "engine" && fail "no engine finding should remain on server: $(on laptop 't3-fleet status --node server')"
pass "fix installs the controller's build on a member over ssh"

# An older controller (the same bundle, marked as an earlier version) reports newer
# builds as newer and installs nothing, rather than putting its own build back.
on laptop "sed -E 's/t3-fleet-build:[0-9]+\.[0-9]+\.[0-9]+:/t3-fleet-build:0.0.1:/' /t3-fleet/bin.mjs > /tmp/old.mjs"
on laptop 'node /tmp/old.mjs --version' | grep -q "^t3-fleet v0.0.1 built" || fail "the older bundle should say it is 0.0.1: $(on laptop 'node /tmp/old.mjs --version')"
expect laptop "newer build" 'node /tmp/old.mjs status --node server'
before=$(on server 'sha256sum ~/.local/share/t3-fleet/t3-fleet.mjs')
out=$(on laptop 'node /tmp/old.mjs fix --yes --area engine' 2>&1) || true
printf '%s' "$out" | grep -q "older build\|install-self\|installed T3 Fleet" && fail "an older controller should offer no install: $out"
[ "$(on server 'sha256sum ~/.local/share/t3-fleet/t3-fleet.mjs')" = "$before" ] || fail "server's build should be unchanged after an older controller's fix"
pass "an older controller offers no downgrade"
