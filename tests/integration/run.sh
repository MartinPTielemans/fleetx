#!/usr/bin/env bash
# End-to-end test on throwaway containers: init on laptop, invite and join
# server and desktop, check them over ssh, sync, propose and approve.
# Usage: tests/integration/run.sh   (needs Docker; builds the bundle first)
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=fleetx-it
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

trap 'docker compose down -v -t 1 >/dev/null 2>&1' EXIT
(cd ../.. && pnpm --filter fleetx build >/dev/null)
docker compose up -d --build --quiet-pull >/dev/null 2>&1

# ssh between nodes as dev, with one shared key; a git identity everywhere.
docker compose exec -T laptop bash -c 'ssh-keygen -q -t ed25519 -N "" -f /keys/id && chmod 644 /keys/id*' >/dev/null
for n in laptop server desktop; do
  docker compose exec -T "$n" bash -c '
    install -o dev -g dev -m 600 /keys/id /home/dev/.ssh/id_ed25519
    install -o dev -g dev -m 644 /keys/id.pub /home/dev/.ssh/authorized_keys
    printf "Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n" > /home/dev/.ssh/config && chown dev /home/dev/.ssh/config
    mkdir -p /home/dev/.local/bin && ln -sf /fleetx/bin.mjs /home/dev/.local/bin/fleetx && chown -R dev:dev /home/dev/.local
    chown dev:dev /srv/remote'
  on "$n" 'git config --global user.name dev && git config --global user.email dev@example.com && git config --global init.defaultBranch main'
done

# A skill to discover, then init.
on laptop 'mkdir -p ~/.agents/skills/demo && printf -- "---\nname: demo\ndescription: d\n---\nhi\n" > ~/.agents/skills/demo/SKILL.md'
expect laptop "Created" 'fleetx init --repo ~/fleet'
on laptop 'grep -q "timer = true" ~/fleet/fleetx.toml && sed -i "s/timer = true/timer = false/" ~/fleet/fleetx.toml && git -C ~/fleet commit -qam "No timers in tests"'
on laptop 'git init -q --bare /srv/remote/fleet.git && git -C ~/fleet remote add origin /srv/remote/fleet.git && git -C ~/fleet push -q -u origin main'
pass "init on laptop, pushed to the shared remote"

for n in server desktop; do
  expect laptop "join /srv/remote/fleet.git $n" "fleetx invite $n"
  out=$(on "$n" "fleetx join /srv/remote/fleet.git $n" 2>&1) || true; printf "%s" "$out" | grep -q "Joined as $n" || fail "join $n: $out"
done
pass "invite and join server and desktop"

out=$(on laptop 'fleetx status --json')
[ "$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.results.filter(x=>x.ok).length)})')" = 3 ] || fail "status should observe 3 nodes: $out"
pass "status observes all three nodes (two over ssh)"

on laptop 'fleetx sync' >/dev/null || true
on server 'fleetx sync' >/dev/null || true
on laptop 'fleetx secrets set TEST_SECRET=hello' >/dev/null
on desktop 'fleetx sync' >/dev/null || true
expect laptop "synced" 'fleetx sync'
on desktop 'fleetx sync' >/dev/null || true
[ "$(on desktop 'grep -c TEST_SECRET ~/.config/fleetx/secrets.env')" = 1 ] || fail "desktop should have the secret after the authority added its key"
pass "an authority's sync lets joined nodes read the secrets"

on desktop 'mkdir -p ~/fleet/skills/proposed && printf -- "---\nname: proposed\ndescription: p\n---\nx\n" > ~/fleet/skills/proposed/SKILL.md'
expect desktop "proposed 1 file" 'fleetx sync'
expect laptop "desktop" 'fleetx review'
expect laptop "approved" 'fleetx approve desktop'
on desktop 'fleetx sync' >/dev/null
[ -z "$(on desktop 'git -C ~/fleet status --porcelain')" ] || fail "desktop should be clean after its approved proposal came back"
pass "propose, review, approve, and the change returns cleanly"

expect laptop "3 environments" 'fleetx status --all'
pass "status --all reads every node's published state"
