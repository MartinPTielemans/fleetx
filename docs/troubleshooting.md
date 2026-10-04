# Troubleshooting

`t3-fleet doctor` checks what T3 Fleet and T3 run on; `t3-fleet status` checks
everything else. Each finding has a key (the part after the machine name in
its id, `laptop:node-too-old`). This page explains each runtime, engine,
mcp, provider-login and models key and what to do. A test keeps it complete: adding a finding to those
areas without documenting it here fails the build.

## runtime

**`node-too-old`** — T3 Fleet and T3 need Node 24 or newer. Install a current
Node from your package manager; T3 Fleet's units prefer `/opt/homebrew/bin`,
`/usr/local/bin`, `/usr/bin` and a Nix profile over a version manager's
directory, which an upgrade can delete.

**`t3-fleet-git-config-missing`** — T3 Fleet's git reads only
`~/.config/t3-fleet/gitconfig`, never your own git config, so a rule there (such
as rewriting GitHub HTTPS to SSH) cannot break unattended sync. The fix writes
that file: your name and email, and `gh` as the GitHub credential helper.

**`remote-unreachable`** — the config repo's remote cannot be reached the way
the sync timer reaches it: no terminal, no SSH agent. Use an HTTPS remote and
run `gh auth login` once. If the remote is SSH, the fix switches it to HTTPS.

**`git-rewrites-to-ssh`** — a note: your git config rewrites GitHub HTTPS to
SSH. T3 Fleet's own git ignores it, but other unattended git (T3's auto-pull,
scripts) cannot use an SSH agent either.

**`local-bin-not-on-path`** — `~/.local/bin`, where T3 Fleet and the agent CLIs
live, is not on the login PATH, so login shells and ssh sessions cannot find
them. The fix adds it in `~/.profile`.

## engine

**`engine-outdated`** — this machine runs an older T3 Fleet build than the
controller (or none). Each build carries its version, build time and commit;
`t3-fleet --version` shows them. The fix streams the controller's build over
ssh to `~/.local/share/t3-fleet/t3-fleet.mjs`, links it as
`~/.local/bin/t3-fleet` (and `~/.local/bin/fleetx`, until 1.0), and restarts
T3 Fleet's services: when the machine runs the relay, the listener or the
model proxy the fix says it interrupts them, so `fix --safe` leaves it out.
When neither build is known to be newer the fix asks first. A `t3-fleet ui`
or `t3-fleet mcp` that started before a newer build was installed on its own
machine does not install its build anywhere; restart it.

**`engine-newer-here`** — this machine runs a newer T3 Fleet build than the
controller. Nothing is installed here, since that would downgrade it; upgrade
T3 Fleet where you run it from (`install.sh`, or `t3-fleet fix` from a
machine that has the newer build).

**`engine-local-config`** — `~/.config/t3-fleet/config.toml` does not name this
machine and its config repo. The fix writes it (as `t3-fleet join` would).

**`engine-timer`** — `[engine] timer = true` but the sync timer is missing,
out of date, or not running. The fix installs a launchd agent (macOS) or a
systemd timer (a user unit, or a system unit for root) that runs the absolute
node binary with a fixed PATH. Logs: `~/.local/state/t3-fleet/sync.log`.

**`engine-timer-unwanted`** — a sync timer is installed but this machine's
settings do not ask for one. The fix removes it.

**`engine-legacy-dirs`** — this machine was set up when T3 Fleet was called
fleetx, and `~/.config/fleetx`, `~/.local/state/fleetx` or
`~/.local/share/fleetx` are still real directories. Until they move, T3 Fleet
keeps using them. The fix moves each to its `t3-fleet` name and leaves a link
at the old one, so anything still using it keeps working; if both names
already exist, the old directory's files are copied over without replacing
any, and it is kept beside the new one as `<dir>.migrated.<time>`. The share
directory moves once the new build is installed (`engine-outdated` first).

**`engine-repo-names`** — on the authority: the config repo still uses
fleetx's names (`fleetx.toml`, `fleetx/state|staging|rejected/<node>`
branches, `FLEETX_*` secrets). It is a note until every configured machine
runs the controller's build, then a warning with the fix `t3-fleet repo
rename`: it moves `fleetx.toml` to `t3-fleet.toml`, renames `FLEETX_RELAY_TOKEN`
and `FLEETX_MCP_TOKEN_*` in the settings, adds every `FLEETX_*` secret under
its `T3_FLEET_*` name (keeping the old one until 1.0), commits, pushes, and
moves the branches. Each step is skipped when done, so it can run again.
Machines that have not pulled yet keep working: until 1.0 every build reads
both names.

Installing the sync timer, the relay's services and the model proxy also
stops and removes the units they had under their fleetx names
(`dev.fleetx.*`, `fleetx-*`).

## Provider logins

**`provider-logged-out-<instance>`** — T3 reports that provider instance as
not logged in, so every turn with it fails although the provider still
starts. Sign in on that machine: `claude auth login` for Claude, `codex
login` for Codex, T3's provider settings for the others. Claude logins drop
when several Claude processes refresh one rotating token at once; for a
credential that does not expire, run `claude setup-token`, store it with
`t3-fleet secrets set CLAUDE_CODE_OAUTH_TOKEN=<token>` on an authority, and turn
on `[models]`, whose launcher hands it to Claude.

**`provider-unhealthy-<instance>`** — T3 marks that provider instance as
warning or error; the detail is T3's own message (an update it wants, a
missing binary, an account problem).

**`t3-access`** — T3 Fleet reads provider logins and health from T3 itself,
with a token of its own that can only read (`orchestration:read`). This
machine has none, it expires within three days, or T3 refused it. The fix,
`t3-fleet t3 connect`, has T3's CLI issue a one-time pairing credential
(`t3 auth pairing create`), exchanges it at T3's `/oauth/token` for a
read-only token, and writes it to `~/.config/t3-fleet/t3-access.json` (mode
600). T3 lists it among its clients as "T3 Fleet", where it can be revoked.
Until then only Claude and Codex are checked, through `claude auth status`
and `codex login status`.

## models

**`provider-token-missing-<instance>`** — `[models]` routes that provider,
its recipe names a long-lived credential (`token_env`; for Claude
`CLAUDE_CODE_OAUTH_TOKEN`), and this machine's secrets do not have it, so the
provider keeps a login that can expire. For Claude run `claude setup-token`
once; then `t3-fleet secrets set <token_env>=<token>` on an authority. Nodes
pick it up on sync.

**`models-service`** — the model proxy's service is missing, out of date, not
running, or not answering on 127.0.0.1:8398. The fix (re)installs and
restarts it. Until it runs, the launchers start the CLIs directly. Log:
`~/.local/state/t3-fleet/models.log`.

**`models-launcher-<instance>`** — that instance's launcher
(`~/.local/bin/t3-fleet-claude`, `t3-fleet-codex`, `t3-fleet-<instance>`) is missing
or differs from what its recipe says. The fix rewrites it.

**`models-legacy-launcher-<instance>`** — a `~/.local/bin/fleetx-<instance>`
launcher from before the rename is still there, and T3 no longer starts the
instance through it (`models-not-routed-<instance>` re-points T3 to the new
one). The fix deletes it.

**`models-not-routed-<instance>`** — T3 starts that provider instance
directly rather than through its launcher. The fix, `t3-fleet models route
<instance>`, sets the instance's binary path in `~/.t3/userdata/settings.json`
(T3 has no command for it and reloads the file itself); running sessions keep
their binary. `t3-fleet models route <instance> --undo` puts the old path back.
It is offered once the launcher is installed.

**`models-unroutable-<instance>`** — a note: that instance cannot go through
the proxy. Either it runs inside T3 with no CLI (Cursor, Antigravity), or
T3 Fleet has no recipe for its driver; declare one with
`[models.providers.<instance>] env` or `args` if its CLI takes a base URL, or
set `route = false` to silence it.

**`models-failing`** — more than 5% of an upstream's requests failed in the
last hour, or launches fell back to the CLI because the proxy was not
listening. The detail names the most common failure class: `connect` and
`timeout` (the network), `429` and `529` (rate limits, overload), `5xx`,
`4xx`, or `stream` (broken off after it started). `t3-fleet models stats` shows
the windows; `~/.local/state/t3-fleet/models.jsonl` has every request's
metadata.

## mcp

**`mcp-<name>-undefined`** — the node lists a server whose `mcp/<name>.json`
is missing, invalid, or cannot be resolved (a hosted server with neither
`[mcp] hub = true` and `gateway`, nor an `origin` and port).

**`mcp-<name>-unregistered`** — Claude or Codex has the server registered
differently from the definition, or not at all. The fix re-registers it.

**`mcp-<name>-down`** — the server did not answer an `initialize`. With the
hub, `t3-fleet mcp servers` on any machine shows why; a 401 means its
credential expired: `t3-fleet mcp login <name>`.

**`mcp-<name>-needs-login`** — the hub has no working login for the server:
it was never signed in, the refresh token was revoked, or someone signed out.
A person signs in, so there is no automatic fix: run `t3-fleet mcp login <name>`
on any machine and open the URL it prints in any browser on the tailnet.

**`mcp-toolhive-left`** — the hub serves these servers now, but ToolHive
still runs them on this machine. The fix runs `thv stop` for them (marked as
disrupting them until the hub serves them; sign in to OAuth servers first).
`thv start` brings one back; `thv rm` removes them for good.

## Other common findings

**`t3-latest-unknown`**, **`claude-latest-unknown`**, **`codex-latest-unknown`**
— the newest release could not be looked up, so whether this machine is
behind is unknown; the detail says why. Lookups are kept for 15 minutes in
`~/.local/state/t3-fleet/latest.json` and then revalidated, which GitHub does
not count against its limit of 60 anonymous requests an hour; with the UI
open and no `gh auth login` (or `GITHUB_TOKEN`) that limit can still run out.

**`t3-protocol-behind`** — T3's apps (desktop, web and the phone app) speak
one client protocol and refuse a server on another, showing "Client not
supported". This machine's T3 speaks an older one than the others, so no app
can reach all of them. Update T3 here (`t3-fleet fix`), or, when the apps are
the older side, update the apps; until an app catches up, accept the T3
finding on the machines you need from it rather than letting sync update them.

**A provider "will not start in T3"** — the T3 server launches providers with
its own environment, which can lack directories your shell has. `status`
shows the launch error; point the provider at an absolute path, or make the
binary reachable from the server's PATH.

**"T3 runs codex from …, not the managed codex"** — another copy shadows the
one T3 Fleet keeps current (a version manager's shim, a distribution package).
Remove the other copy, or point T3 at `~/.local/bin/codex`.

**"MCP server … does not answer: Token temporarily unavailable"** — the
server's credential on the machine hosting it expired. With the T3 Fleet hub,
`t3-fleet mcp login <name>`; otherwise sign in again in the MCP runner there.
Nobody can do this unattended.

**A proposal never arrives** — only changes under `[fleet] auto_commit` paths
are proposed, and only by `t3-fleet sync`. `t3-fleet review` on an authority lists
what is waiting.

**Logs** — `~/.local/state/t3-fleet/sync.log`, `listen.log`, `serve.log` (the
relay and its hub), `models.log`; the hub's call log is `~/.local/state/t3-fleet/hub/calls.jsonl`.
