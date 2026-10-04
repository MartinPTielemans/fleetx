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
`~/.local/bin/t3-fleet`, and restarts the relay and the listener when the
machine runs them, which interrupts them: the fix says so, and `fix --safe`
leaves it out. (The model proxy picks up the
new build itself, once its streams finish.) When neither build is known to be
newer, the fix asks first. A `t3-fleet ui`
or `t3-fleet mcp` that started before a newer build was installed on its own
machine does not install its build anywhere; restart it.

**`engine-newer-here`** — this machine runs a newer T3 Fleet build than the
controller. Nothing is installed here, since that would downgrade it; upgrade
T3 Fleet where you run it from (`install.sh`, or `t3-fleet fix` from a
machine that has the newer build).

**`engine-local-config`** — `~/.config/t3-fleet/config.toml` does not name this
machine and its config repo. The fix writes it (as `t3-fleet join` would). Sync
never runs it: which repo a machine uses is a person's choice (`join --dir`,
`T3_FLEET_CONFIG_REPO`), and pointing it at a missing one stops every sync. A
machine's own sync checks the repo it loaded, so `join --dir` does not raise it.

**`engine-timer`** — `[engine] timer = true` but the sync timer is missing,
out of date, or not running. The fix installs a launchd agent (macOS) or a
systemd timer (a user unit, or a system unit for root) that runs the absolute
node binary with a fixed PATH. Logs: `~/.local/state/t3-fleet/sync.log`. On
macOS, when a sync the timer started applies this fix, reloading the agent
would stop that sync and the fix with it, so a helper does the reload once the
sync has finished. Until it has, `~/.local/state/t3-fleet/sync-timer-reload.pending`
says so; if it is still there once that sync is over (the helper failed, the Mac
slept), `engine-timer` (or `engine-timer-unwanted`, for a removal) reports that
launchd never reloaded the timer, and the fix tries again.

**`engine-timer-unwanted`** — a sync timer is installed but this machine's
settings do not ask for one. The fix removes it.

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
and `codex login status`. Sync renews a token that expires within three days,
or has expired, by itself (the `t3` area is in the default `[fleet] apply`), at
most once a day: every attempt, failed or not, is noted in
`~/.local/state/t3-fleet/t3-access-attempt`, since each one adds a "T3 Fleet"
client in T3. A new token that is itself due within three days is kept but the
fix fails, so it is not mistaken for a renewal. A first connection, or a token
T3 refused (a person revoked it) before it expired, waits for a person.

## models

**`provider-token-missing-<instance>`** — `[models]` routes that provider,
its recipe names a long-lived credential (`token_env`; for Claude
`CLAUDE_CODE_OAUTH_TOKEN`), and this machine's secrets do not have it, so the
provider keeps a login that can expire. For Claude run `claude setup-token`
once; then `t3-fleet secrets set <token_env>=<token>` on an authority. Nodes
pick it up on sync.

**`models-service`** — the model proxy's service is missing, out of date, not
running, or not answering on 127.0.0.1:8398. The fix (re)installs and
restarts it; a restart waits up to 45 seconds for the responses in flight.
Until it runs, the launchers start the CLIs directly. Installing a new build
does not restart it: the proxy notices the build within a minute, keeps
answering until its last response is done (15 minutes at most), exits, and
its service starts it again a second later. Log (start-up lines only, no
per-request lines): `~/.local/state/t3-fleet/models.log`.

**`models-launcher-<instance>`** — that instance's launcher
(`~/.local/bin/t3-fleet-claude`, `t3-fleet-codex`, `t3-fleet-<instance>`) is missing
or differs from what its recipe says. The fix rewrites it.

**`models-not-routed-<instance>`** — T3 starts that provider instance
directly rather than through its launcher. The fix, `t3-fleet models route
<instance>`, sets the instance's binary path in `~/.t3/userdata/settings.json`
(T3 has no command for it and reloads the file itself); running sessions keep
their binary. `t3-fleet models route <instance> --undo` puts the old path back.
It is offered once the launcher is installed, and only when the CLI the
launcher runs is there: its recipe's `command` (for Claude
`~/.local/bin/claude`, or `claude` on PATH). If it is not, the finding says
so; install the CLI or set `[models.providers.<instance>] command`.

**`models-unroutable-<instance>`** — a note: that instance cannot go through
the proxy. Either it runs inside T3 with no CLI (Cursor, Antigravity), or
T3 Fleet has no recipe for its driver; declare one with
`[models.providers.<instance>] env` or `args` if its CLI takes a base URL, or
set `route = false` to silence it.

**`models-failing`** — more than 5% of an upstream's requests failed in the
last hour (and at least three of them), or launches fell back to the CLI
because the proxy was not listening. The detail names the most common failure
class: `connect` and `timeout` (the network), `429` and `529` (rate limits,
overload), `5xx`, or `stream` (broken off after it started, including a
response cut by the proxy stopping). Client errors (`4xx`: a prompt too long,
a request too large) are the request's own problem and do not count, though
`t3-fleet models stats` still shows them. `t3-fleet models stats` shows the
windows; `~/.local/state/t3-fleet/models.jsonl` has every request's metadata.
With `egress = "relay"`, an error the relay met on the way to the upstream
says "at the relay"; when the relay itself cannot be reached, requests go
direct and do not fail.

## mcp

**`mcp-<name>-undefined`** — the node lists a server whose `mcp/<name>.json`
is missing, invalid, or cannot be resolved (a hosted server with neither
`[mcp] hub = true` and `gateway`, nor an `origin` and port).

**`mcp-<name>-unregistered`** — Claude or Codex has the server registered
differently from the definition, or not at all. The fix re-registers it. When
the existing registration has settings a definition cannot express (an `env`,
headers besides Authorization, Codex's per-server options such as
`startup_timeout_sec`), the detail names them and sync leaves the fix to a
person, since re-registering would drop them.

**`mcp-<name>-down`** — the server did not answer an `initialize`. With the
hub, `t3-fleet mcp servers` on any machine shows why; a 401 means its
credential expired: `t3-fleet mcp login <name>`.

**`mcp-<name>-needs-login`** — the hub has no working login for the server:
it was never signed in, the refresh token was revoked, someone signed out, or
the definition's `url` changed (a login is only sent to the URL it was issued
for). A person signs in, so there is no automatic fix: run `t3-fleet mcp login <name>`
on any machine and open the URL it prints in any browser on the tailnet. If
the provider's page says it does not know the client, run
`t3-fleet mcp logout <name>` first: the next login registers the hub again.

**`mcp-toolhive-left`** — the hub serves these servers now, but ToolHive
still runs them on this machine. The fix runs `thv stop` for them (marked as
disrupting them until the hub serves them; sign in to OAuth servers first).
`thv start` brings one back; `thv rm` removes them for good.

## relay

**`relay-token-missing`** — the relay (or a machine's relay listener) reads
`T3_FLEET_RELAY_TOKEN` from the machine's secrets and exits without it, so
T3 Fleet offers no service until it is there. If the fleet has no relay token
yet, on an authority run
`t3-fleet secrets set T3_FLEET_RELAY_TOKEN="$(openssl rand -hex 32)"`, then
`t3-fleet sync` on the machine. If the fleet has one, the machine cannot read
the fleet's secrets yet: see the secrets findings for it.

**`relay-tailscale-missing`** — the relay is reached at a tailnet name (a
MagicDNS name such as `server.tailnet.ts.net`, or a 100.x address) and its
port is published with `tailscale serve`, but the `tailscale` command is not
on this machine, on PATH or inside the macOS app.
Install Tailscale and run `tailscale up`.

**`relay-docker-missing`** — the hub runs `container` or `registry` servers
from `mcp/` with Docker, and `docker` is not on the relay machine. Install
Docker for the user T3 Fleet runs as; until then those servers do not answer.

**`relay-<role>`** — the relay service (`relay-serve`, on the relay machine)
or the listener (`relay-listen`, everywhere else) is missing, out of date or
not running. The fix installs and restarts it.

**`relay-unpublished`** — the relay's port is not published to the tailnet.
The fix runs `tailscale serve` for it.

## T3

Each problem observing T3 has a key of its own, so an `[[accept]]` for one
never covers another. Up to T3 Fleet 0.6.1 they were numbered (`t3-problem-1`, and
`plugin-problem-1` for plugins), and the number moved when the list changed.
An `[[accept]]` written for a numbered id no longer matches anything: replace it
with the new id, which `t3-fleet status` shows. The first sync after upgrading
also sends one round of alerts in which each such finding appears under its new
id and is resolved under its old one; nothing changed on the machine.

- **`t3-not-running`** — T3 has run here, but no server is up (stopped, or
  mid-restart), or the one `server-runtime.json` names has exited.
- **`t3-no-descriptor`** — the server did not answer `/.well-known/t3/environment`.
- **`t3-env-unreadable`** — T3 Fleet could not read the running server's
  environment, so providers were checked with the login PATH instead.
- **`t3-runtime-unreadable`** — `~/.t3/userdata/server-runtime.json` is unreadable.
- **`t3-settings-unrecognized`** — T3's `settings.json` did not match the
  provider settings T3 Fleet reads.

## Areas and plugins

**`<area>-unreadable`** — an area could not check this machine: its observation
failed or threw, did not match its own schema, or its diagnosis threw. The
detail says which. The other areas are checked as usual; for a plugin area,
fix the plugin.

**`plugin-failed-<path>`** — a plugin listed in `[plugins] areas` did not load:
the file is missing, does not export a default function, its function threw,
or its area id is missing or taken.

**`sync-stale`** — no sync has finished here for four of this machine's
`[engine] interval`s (an hour, by default). Is the sync timer running?

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
what is waiting. A machine whose pull failed (its own edits overlap incoming
changes, say) proposes nothing until a sync there pulls again.

**`sync-secret-<unit>`** — sync would not commit (an authority), propose
(any other machine) or push something, because a line it adds looks like a
secret: a token, a password in a URL, a bearer header, a private key. A unit
is a whole skill (`skills/<name>`), with `skills/SOURCES.json` when it
changed alongside, or a single file elsewhere: half a skill never reaches
the other machines. The finding names the line and the kind, never the value
or its hash. Move the value into the fleet's secrets
(`t3-fleet secrets set NAME=VALUE` on an authority) and refer to it as
`${NAME}`.

If the line is not a secret (an example in a vendored skill's docs, say),
`t3-fleet secrets scan` on that machine prints each line's
`t3-fleet secrets allow <file> <hash>` command; an authority runs it, which
adds to `t3-fleet.toml`:

```toml
[[allow_secret]]
file = "skills/mapbox/README.md"
line = "<the line's SHA-256, from the refusal>"
```

The hash is of that line's text, so the entry stops matching when the line
changes. A machine without the authority role trusts only the entries
committed on the branch. Only the lines a commit adds are checked: what is
already committed never blocks a later change to the same file.

A held-back unit stays in the checkout as an edit. When a change from the
branch (or a proposal the authority approves) touches it, sync sets it aside
in `git stash` as `T3 Fleet: held back <unit>`, so pulling keeps working, and
the finding says so until the stash entry is dropped:
`git -C <repo> stash apply <entry>` brings the edits back. A commit made by
hand that adds a secret is not pushed; `git -C <repo> reset --soft
origin/main` turns it back into edits for sync to sort.

Commands refuse the same way, naming file, line and kind with the allow
command. A refused `skills add`, `skills update` or `mcp add` puts back the
files it wrote, so no later sync commits part of them; run it again once the
line is allowed.

**`sync-local-commits`** — a machine without the authority role has commits
of its own in the config repo. Only an authority's commits reach the other
machines, so these go nowhere; sync rebases them along and keeps working.
`git -C <repo> reset --soft origin/main` there turns them back into edits,
which its next sync proposes for approval.

**"…'s proposal is … now, not the … reviewed"** — the proposal changed after
`t3-fleet review` showed it, and is not the same change made again on a newer
branch. Review it again and approve the commit it shows:
`t3-fleet approve <node> <commit>`.

**"…'s proposal conflicts with what reached main since it was made"** — an
approval applies only what the proposal itself changed, merged with what the
branch has now, and never undoes newer work. When both changed the same lines
it refuses: reject the proposal, or let that machine pull and propose again.

**"…'s proposal would change …, which it does not name"** — the branch moved
or renamed a file the proposal edits, and applying the edit would land in the
new place, outside what was reviewed (or what `auto_approve` trusts). Reject
it, or let that machine pull and propose again.

**"a sync is running on this machine; try again in a moment"** — every command
that writes to the config repo (approve, reject, skills, secrets, invite, `repo
rename`) waits its turn with sync, so sync never commits or proposes half an
edit. The lock is `~/.local/state/t3-fleet/sync.lock`, holding the pid of its
run; it is taken over once that process has gone (died, or its pid reused
after a reboot), never just because it is old, so a laptop asleep mid-sync
keeps it. `listen` retries a sync it could
not start.

**"local edits to … conflicted with incoming changes; they are kept in git
stash"** — the pull put the branch's version in place rather than leave
conflict markers in a live file. `git stash list` in the checkout has your
edits.

**Logs** — `~/.local/state/t3-fleet/sync.log`, `listen.log`, `serve.log` (the
relay and its hub), `models.log`; the hub's call log is `~/.local/state/t3-fleet/hub/calls.jsonl`.
