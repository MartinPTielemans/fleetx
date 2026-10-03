# Troubleshooting

`fleetx doctor` checks what fleetx and T3 run on; `fleetx status` checks
everything else. Each finding has a key (the part after the machine name in
its id, `laptop:node-too-old`). This page explains each runtime, engine and
mcp key and what to do. A test keeps it complete: adding a finding to those
areas without documenting it here fails the build.

## runtime

**`node-too-old`** — fleetx and T3 need Node 24 or newer. Install a current
Node from your package manager; fleetx's units prefer `/opt/homebrew/bin`,
`/usr/local/bin`, `/usr/bin` and a Nix profile over a version manager's
directory, which an upgrade can delete.

**`fleetx-git-config-missing`** — fleetx's git reads only
`~/.config/fleetx/gitconfig`, never your own git config, so a rule there (such
as rewriting GitHub HTTPS to SSH) cannot break unattended sync. The fix writes
that file: your name and email, and `gh` as the GitHub credential helper.

**`remote-unreachable`** — the config repo's remote cannot be reached the way
the sync timer reaches it: no terminal, no SSH agent. Use an HTTPS remote and
run `gh auth login` once. If the remote is SSH, the fix switches it to HTTPS.

**`git-rewrites-to-ssh`** — a note: your git config rewrites GitHub HTTPS to
SSH. fleetx's own git ignores it, but other unattended git (T3's auto-pull,
scripts) cannot use an SSH agent either.

**`local-bin-not-on-path`** — `~/.local/bin`, where fleetx and the agent CLIs
live, is not on the login PATH, so login shells and ssh sessions cannot find
them. The fix adds it in `~/.profile`.

## engine

**`fleetx-outdated`** — this machine runs a different fleetx build than the
controller. The fix streams the controller's build over ssh to
`~/.local/share/fleetx/fleetx.mjs` and restarts fleetx's services.

**`fleetx-local-config`** — `~/.config/fleetx/config.toml` does not name this
machine and its config repo. The fix writes it (as `fleetx join` would).

**`fleetx-timer`** — `[engine] timer = true` but the sync timer is missing,
out of date, or not running. The fix installs a launchd agent (macOS) or a
systemd timer (a user unit, or a system unit for root) that runs the absolute
node binary with a fixed PATH. Logs: `~/.local/state/fleetx/sync.log`.

**`fleetx-timer-unwanted`** — a sync timer is installed but this machine's
settings do not ask for one. The fix removes it.

## mcp

**`mcp-<name>-undefined`** — the node lists a server whose `mcp/<name>.json`
is missing, invalid, or cannot be resolved (a hosted server with neither
`[mcp] hub = true` and `gateway`, nor an `origin` and port).

**`mcp-<name>-unregistered`** — Claude or Codex has the server registered
differently from the definition, or not at all. The fix re-registers it.

**`mcp-<name>-down`** — the server did not answer an `initialize`. With the
hub, `fleetx mcp servers` on any machine shows why; a 401 means its
credential expired: `fleetx mcp login <name>`.

**`mcp-<name>-needs-login`** — the hub has no working login for the server:
it was never signed in, the refresh token was revoked, or someone signed out.
A person signs in, so there is no automatic fix: run `fleetx mcp login <name>`
on any machine and open the URL it prints in any browser on the tailnet.

**`mcp-toolhive-left`** — the hub serves these servers now, but ToolHive
still runs them on this machine. The fix runs `thv stop` for them (marked as
disrupting them until the hub serves them; sign in to OAuth servers first).
`thv start` brings one back; `thv rm` removes them for good.

## Other common findings

**A provider "will not start in T3"** — the T3 server launches providers with
its own environment, which can lack directories your shell has. `status`
shows the launch error; point the provider at an absolute path, or make the
binary reachable from the server's PATH.

**"T3 runs codex from …, not the managed codex"** — another copy shadows the
one fleetx keeps current (a version manager's shim, a distribution package).
Remove the other copy, or point T3 at `~/.local/bin/codex`.

**"MCP server … does not answer: Token temporarily unavailable"** — the
server's credential on the machine hosting it expired. With the fleetx hub,
`fleetx mcp login <name>`; otherwise sign in again in the MCP runner there.
Nobody can do this unattended.

**A proposal never arrives** — only changes under `[fleet] auto_commit` paths
are proposed, and only by `fleetx sync`. `fleetx review` on an authority lists
what is waiting.

**Logs** — `~/.local/state/fleetx/sync.log`, `listen.log`, `serve.log` (the
relay and its hub); the hub's call log is `~/.local/state/fleetx/hub/calls.jsonl`.
