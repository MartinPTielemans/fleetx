#!/usr/bin/env bash
# End-to-end test on throwaway containers, around `t3-fleet setup`.
#
# laptop and desktop start with what real machines have (seed.sh): skills in
# all three places, a clash between them, a git-cloned skill repository, MCP
# servers with credentials in headers, env, a query string, args and a
# connection string, an sse and a localhost server, a Claude project's server,
# and a different CLAUDE.md on each. laptop starts the fleet, server joins as
# the relay, desktop joins with its differences; an authority approves. Then
# the machines must be equivalent, and no credential may be anywhere in the
# repository's history. The rest covers sync, proposals, skills from git, the
# MCP server, and installing builds over the last release (0.7.1).
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
# What a machine has where setup looks, to show --plan changed none of it.
state() { on "$1" 'cd ~ && { find .agents .claude .codex -printf "%p %y %l\n" 2>/dev/null | sort; cat .claude.json .codex/config.toml 2>/dev/null; ls -d fleet .config/t3-fleet .local/state/t3-fleet 2>/dev/null; } | sha256sum'; }

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
  docker compose cp seed.sh "$n:/tmp/seed.sh" >/dev/null 2>&1
done
for n in laptop server desktop; do on "$n" "bash /tmp/seed.sh $n"; done

# Before setup: every command says what to do, and doctor is setup's pre-flight.
expect laptop "t3-fleet setup" 't3-fleet status'
expect laptop "not set up yet" 't3-fleet doctor'
expect laptop "no sync timer" 't3-fleet doctor'
pass "before setup, status and doctor point to setup"

# --plan shows everything and changes nothing.
before=$(state laptop)
plan=$(on laptop 'LINEAR_KEY=lin_SEKRIT_env_0008 t3-fleet setup --plan' 2>&1) || fail "setup --plan failed: $plan"
for want in "skill   fmt  from ~/.claude/skills (/srv/remote/toolbox.git @" "skill   lint" "server  localdb  this machine only" \
  "server  db  declared, registered nowhere" "skill plug (~/.claude/skills/plug): a Claude plugin's" "2 different copies\|skill   demo" \
  "POSTHOG_TOKEN" "SEARCH_API_KEY" "CTX_API_KEY" "CTX_API_TOKEN" "DB_PASSWORD" "LINEAR_KEY" "GH_TOKEN" "REMOTE_TOKEN" \
  "server node_repl: an app's own server" "server old: disabled in Codex" "nothing was written"; do
  printf '%s' "$plan" | grep -q -- "$want" || fail "setup --plan should show /$want/:
$plan"
done
printf '%s' "$plan" | grep -q SEKRIT && fail "the plan should mask every secret:
$plan"
[ "$(state laptop)" = "$before" ] || fail "setup --plan changed the machine"
pass "setup --plan shows skills, servers, secrets (masked) and what it leaves alone, and writes nothing"

# The first machine.
on laptop 'git init -q --bare /srv/remote/fleet.git'
expect laptop "laptop is set up" 'LINEAR_KEY=lin_SEKRIT_env_0008 t3-fleet setup --yes --remote /srv/remote/fleet.git'
[ "$(on laptop 'stat -c %a ~/.local/state/t3-fleet/setup/before.json')" = 600 ] || fail "before.json should be mode 600"
expect laptop "phx_SEKRIT_header_0001" 'cat ~/.local/state/t3-fleet/setup/before.json'
expect laptop '"path": "/home/dev/.claude/skills/toolbox"' 'cat ~/.local/state/t3-fleet/setup/before.json'
expect laptop '"path": "/home/dev/.codex/skills/demo"' 'cat ~/.local/state/t3-fleet/setup/before.json'
[ -z "$(on laptop 'git -C ~/fleet ls-files -s skills | grep "^160000"')" ] || fail "a cloned skill should never be committed as a gitlink"
expect laptop "skills/fmt/SKILL.md" 'git -C ~/fleet ls-files skills'
expect laptop '"commit": "' 'cat ~/fleet/skills/SOURCES.json'
expect laptop '"fmt": "skills/fmt"' 'cat ~/fleet/skills/SOURCES.json'
expect laptop '"transport": "sse"' 'cat ~/fleet/mcp/events.json'
expect laptop '"servers.add" = \["localdb"\]' 'cat ~/fleet/nodes/laptop.toml'
expect laptop '"ignore.add" = \["node_repl", "old"\]' 'cat ~/fleet/nodes/laptop.toml'
expect laptop 'Authorization: Bearer $REMOTE_TOKEN' 'cat ~/fleet/mcp/remote.json'
expect laptop 'https://$GH_TOKEN@git.example/mcp' 'cat ~/fleet/mcp/gh.json'
expect laptop 'timer = false' 'cat ~/fleet/nodes/laptop.toml'
on laptop 'grep "^servers" ~/fleet/t3-fleet.toml' | grep -q '"db"\|"localdb"' && fail "a project's server and a localhost one are not every machine's"
expect laptop 'dest = "~/.claude/CLAUDE.md"' 'grep -A2 "defaults.instructions" ~/fleet/t3-fleet.toml'
expect laptop "builtin" 'ls ~/.codex/skills/.system'
[ -z "$(on laptop 'ls ~/.codex/skills')" ] || fail "Codex reads ~/.agents/skills: its own copy should be moved aside"
[ "$(on laptop 'readlink ~/.claude/skills/plug')" = /home/dev/.claude/plugins/cache/acme/skills/plug ] || fail "the plugin's skill should be left alone"
[ "$(on laptop 'readlink ~/.agents/skills/fmt')" = /home/dev/fleet/skills/fmt ] || fail "fmt should be linked from the repo"
expect laptop "Nothing here differs" 't3-fleet setup'
pass "setup on laptop: repo, secrets, links, snapshot, no gitlinks, project and localhost servers kept to this machine"

for n in server desktop; do
  expect laptop "sh -s -- setup /srv/remote/fleet.git $n" "t3-fleet invite $n"
done
# A joining machine's --plan writes nothing to its home, not even a key.
before=$(state desktop)
expect desktop "nothing was written" 't3-fleet setup /srv/remote/fleet.git desktop --plan'
[ "$(state desktop)" = "$before" ] || fail "setup --plan on a joining machine changed it"
expect server "server is set up" 't3-fleet setup /srv/remote/fleet.git server --yes --relay'
expect desktop "skill review differs from the fleet's: keep mine and propose it" 't3-fleet setup /srv/remote/fleet.git desktop --plan'
expect desktop "CLAUDE.md differs from the fleet's" 't3-fleet setup /srv/remote/fleet.git desktop --plan'
expect desktop "desktop is set up" 't3-fleet setup /srv/remote/fleet.git desktop --yes'
expect desktop "the desktop's newer review" 'cat ~/.claude/skills/review/SKILL.md'
expect desktop '"path": "/home/dev/.claude/skills/review"' 'cat ~/.local/state/t3-fleet/setup/before.json'
pass "server joins as the relay, desktop joins keeping its own review and CLAUDE.md, proposed"

# An authority adds their keys, approves, and the approvals merge their secrets.
on laptop 't3-fleet sync' >/dev/null || true
expect laptop "desktop" 't3-fleet review'
# Both proposals add to t3-fleet.toml; both approve, merged.
expect laptop "secrets it proposes: T3_FLEET_RELAY_TOKEN" 't3-fleet review'
expect laptop "merged T3_FLEET_RELAY_TOKEN" 't3-fleet approve server'
expect laptop "merged NOTES_X_API_KEY" 't3-fleet approve desktop'
for n in server desktop laptop server desktop; do on "$n" 't3-fleet sync' >/dev/null || true; done
expect laptop "url\|port = 8399" 'grep -A2 "^\[relay\]" ~/fleet/t3-fleet.toml'
expect laptop '"relay"' 'cat ~/fleet/nodes/server.toml'
pass "approving proposals merges the secrets each machine proposed"

# Equivalent machines: the same repo, skills, instructions and secrets everywhere.
rev=$(on laptop 'git -C ~/fleet rev-parse HEAD')
skills=$(on laptop 'ls ~/.agents/skills')
for n in laptop server desktop; do
  [ "$(on "$n" 'git -C ~/fleet rev-parse HEAD')" = "$rev" ] || fail "$n should be at $rev"
  [ -z "$(on "$n" 'git -C ~/fleet status --porcelain')" ] || fail "$n's checkout should be clean: $(on "$n" 'git -C ~/fleet status --porcelain')"
  [ "$(on "$n" 'ls ~/.agents/skills')" = "$skills" ] || fail "$n should have the same skills: $(on "$n" 'ls ~/.agents/skills') vs $skills"
  for s in $skills; do
    [ "$(on "$n" "readlink ~/.agents/skills/$s")" = "/home/dev/fleet/skills/$s" ] || fail "$n: $s should link into the repo"
  done
  expect "$n" "the desktop's newer review" 'cat ~/.agents/skills/review/SKILL.md'
  expect "$n" "Desktop rules" 'cat ~/.claude/CLAUDE.md'
  [ "$(on "$n" 'readlink ~/.claude/CLAUDE.md')" = /home/dev/fleet/instructions/claude/CLAUDE.md ] || fail "$n: CLAUDE.md should link into the repo"
  [ "$(on "$n" 'grep -c = ~/.config/t3-fleet/secrets.env')" = 10 ] || fail "$n should have the fleet's 10 secrets: $(on "$n" 'cut -d= -f1 ~/.config/t3-fleet/secrets.env')"
  out=$(on "$n" 't3-fleet config show | grep "mcp.servers ="')
  for s in posthog search ctx events linear gh remote t3-fleet notes weather; do
    printf '%s' "$out" | grep -q "\"$s\"" || fail "$n should register $s: $out"
  done
done
[ -z "$(on laptop "t3-fleet status --json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const f of JSON.parse(s).findings) if(["skills","instructions","secrets","dotfiles"].includes(f.area)) console.log(f.node, f.key)})')" ] \
  || fail "no machine should differ in skills, instructions or secrets: $(on laptop 't3-fleet status')"
pass "laptop, server and desktop are equivalent"

expect laptop "Nothing here differs" 't3-fleet setup'
expect desktop "Nothing here differs" 't3-fleet setup'

# A setup dropped part-way: the next one finishes what it left, rather than finding nothing to do.
on laptop 'mkdir -p ~/.agents/skills/later && printf -- "---\nname: later\ndescription: added later\n---\nlater\n" > ~/.agents/skills/later/SKILL.md'
on laptop 'chmod -R a-w /srv/remote/fleet.git'
expect laptop 'setup stopped at "commit"' 't3-fleet setup --yes'
expect laptop "Not done: commit, config, links, sync" 't3-fleet setup --abandon'
on laptop 'chmod -R u+w /srv/remote/fleet.git'
# Its commit was made, its push refused: the next setup pushes it.
expect laptop "not pushed: skills/later" 't3-fleet setup --plan'
expect laptop "pushed what an earlier run committed: skills/later" 't3-fleet setup --yes'
expect laptop "skills/later/SKILL.md" 'git -C /srv/remote/fleet.git ls-tree -r --name-only main'
[ "$(on laptop 'readlink ~/.agents/skills/later')" = /home/dev/fleet/skills/later ] || fail "later should be linked once the setup is finished"
expect laptop "Nothing here differs" 't3-fleet setup'
pass "a setup dropped with --abandon says what it did, and the next one finishes it"

# Run at all, the real Codex writes under ~/.codex (tmp/arg0, locks, helper links); setup only looks.
on laptop 'printf "#!/bin/sh\nmkdir -p ~/.codex/tmp/arg0/codex-arg0-\$\$\necho codex-cli 0.160.0\n" > ~/.local/bin/codex && chmod +x ~/.local/bin/codex'
before=$(state laptop)
expect laptop "Nothing here differs" 't3-fleet setup'
expect laptop "Nothing here differs" 't3-fleet setup --plan'
[ "$(state laptop)" = "$before" ] || fail "setup with nothing to do, and --plan, should run no agent CLI: $(on laptop 'ls ~/.codex/tmp/arg0 2>&1')"
on laptop 'rm ~/.local/bin/codex'
pass "setup finds how Codex was installed without running it"

# An uncommitted edit to a fleet file is refused before planning: the plan would pass it off as the fleet's,
# and an authority's run would publish it. A file setup never writes (a bootstrap.sh) is not its business.
on laptop 'printf "#!/bin/sh\n" > ~/fleet/bootstrap.sh && cp ~/fleet/mcp/posthog.json /tmp/posthog.json && sed -i "s/mcp.posthog/mcp.draft/" ~/fleet/mcp/posthog.json'
on laptop 'printf "{}\n" > ~/fleet/mcp/new-untracked.json'
expect laptop "uncommitted changes to the fleet's files" 't3-fleet setup --plan'
expect laptop " M mcp/posthog.json" 't3-fleet setup'
# The command it prints sets both aside, the untracked one too, as written.
out=$(on laptop 't3-fleet setup' 2>&1) || true
cmd=$(printf '%s' "$out" | grep -o '`git -C [^`]*stash push[^`]*`' | tr -d '`')
[ -n "$cmd" ] || fail "setup should print a stash command: $out"
on laptop "$cmd" || fail "the printed stash command should work: $cmd"
expect laptop "Nothing here differs" 't3-fleet setup'
expect laptop "mcp.draft" 'git -C ~/fleet stash show -p --include-untracked'
on laptop 'git -C ~/fleet stash drop -q'
[ -z "$(on laptop 'git -C /srv/remote/fleet.git log -p main -- mcp/posthog.json | grep mcp.draft')" ] || fail "the uncommitted edit should never be published"
on laptop 'rm ~/fleet/bootstrap.sh'
pass "setup refuses uncommitted edits to the fleet's files, and ignores files it never writes"

# No credential anywhere in the repository: any branch, any commit, state and proposals included.
leaks=$(on laptop 'git -C /srv/remote/fleet.git log -p --all | grep -o "[A-Za-z_]*SEKRIT[A-Za-z0-9_]*" | sort -u') || true
[ -z "$leaks" ] || fail "credentials in the repository's history: $leaks"
pass "no secret value appears anywhere in the repository's history"

expect laptop "3 environments" 't3-fleet status --all'
pass "status --all reads every node's published state"

on desktop 'mkdir -p ~/fleet/skills/proposed && printf -- "---\nname: proposed\ndescription: p\n---\nx\n" > ~/fleet/skills/proposed/SKILL.md'
expect desktop "proposed 1 file" 't3-fleet sync'
expect laptop "approved" 't3-fleet approve desktop'
on desktop 't3-fleet sync' >/dev/null
[ -z "$(on desktop 'git -C ~/fleet status --porcelain')" ] || fail "desktop should be clean after its approved proposal came back"
pass "propose, review, approve, and the change returns cleanly"

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

# Desktop goes back to the last release, as an older install would have it; status
# still reads it over ssh, and fix installs this build over it.
docker compose cp "$release/t3-fleet.mjs" desktop:/tmp/t3-fleet.mjs >/dev/null 2>&1
on desktop 'mkdir -p ~/.local/share/t3-fleet && install -m 755 /tmp/t3-fleet.mjs ~/.local/share/t3-fleet/t3-fleet.mjs && ln -sfn ~/.local/share/t3-fleet/t3-fleet.mjs ~/.local/bin/t3-fleet'
on desktop 't3-fleet --version' | grep -q "^t3-fleet v$old" || fail "desktop should run $old: $(on desktop 't3-fleet --version')"
out=$(on laptop 't3-fleet status --json')
[ "$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.results.filter(x=>x.ok).length)})')" = 3 ] || fail "status should observe 3 nodes: $out"
pass "status observes all three nodes (two over ssh, one of them on $old)"
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
