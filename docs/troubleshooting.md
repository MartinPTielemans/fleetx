# Troubleshooting

`fleetx doctor` checks what fleetx and T3 run on; `fleetx status` checks
everything else. Each finding has a key (the part after the machine name in
its id, `laptop:node-too-old`). This page explains each runtime, engine and
models key and what to do. A test keeps it complete: adding a finding to those
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

## models

**`claude-logged-out`** — `claude auth status`, run the way T3 runs Claude,
says Claude is not logged in, so every Claude turn in T3 fails although the
provider still starts. Run `claude auth login` on that machine. Logins drop
when several Claude processes refresh one rotating token at once; for a
credential that does not expire, run `claude setup-token`, store it with
`fleetx secrets set CLAUDE_CODE_OAUTH_TOKEN=<token>` on an authority, and turn
on `[models]`, whose launcher hands it to Claude.

**`claude-token-missing`** — `[models]` routes Claude, but this machine's
secrets have no setup-token (`claude_token_env`, `CLAUDE_CODE_OAUTH_TOKEN` by
default), so Claude keeps a login that can expire. Run `claude setup-token`
once, then `fleetx secrets set CLAUDE_CODE_OAUTH_TOKEN=<token>` on an
authority; nodes pick it up on sync.

**`models-service`** — the model proxy's service is missing, out of date, not
running, or not answering on 127.0.0.1:8398. The fix (re)installs and
restarts it. Until it runs, the launchers start the CLIs directly. Log:
`~/.local/state/fleetx/models.log`.

**`models-launcher`** — `~/.local/bin/fleetx-claude` or `fleetx-codex` is
missing or differs from what this fleetx writes. The fix rewrites it.

**`models-not-routed-<instance>`** — T3 starts that provider instance
directly rather than through its launcher. The fix, `fleetx models route
<instance>`, sets the instance's binary path in `~/.t3/userdata/settings.json`
(T3 has no command for it and reloads the file itself); running sessions keep
their binary. `fleetx models route <instance> --undo` puts the old path back.
It is offered once the launcher is installed.

**`models-failing`** — more than 5% of a provider's requests failed in the
last hour, or launches fell back to the CLI because the proxy was not
listening. The detail names the most common failure class: `connect` and
`timeout` (the network), `429` and `529` (rate limits, overload), `5xx`,
`4xx`, or `stream` (broken off after it started). `fleetx models stats` shows
the windows; `~/.local/state/fleetx/models.jsonl` has every request's
metadata.

## Other common findings

**A provider "will not start in T3"** — the T3 server launches providers with
its own environment, which can lack directories your shell has. `status`
shows the launch error; point the provider at an absolute path, or make the
binary reachable from the server's PATH.

**"T3 runs codex from …, not the managed codex"** — another copy shadows the
one fleetx keeps current (a version manager's shim, a distribution package).
Remove the other copy, or point T3 at `~/.local/bin/codex`.

**"MCP server … does not answer: Token temporarily unavailable"** — the
server's credential on the machine hosting it expired. Sign in again there
(for ToolHive, its OAuth flow); fleetx cannot do this unattended.

**A proposal never arrives** — only changes under `[fleet] auto_commit` paths
are proposed, and only by `fleetx sync`. `fleetx review` on an authority lists
what is waiting.

**Logs** — `~/.local/state/fleetx/sync.log`, `listen.log`, `serve.log`,
`models.log`.
