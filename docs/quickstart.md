# Quickstart

From one machine to two, with what each already has.

## 1. Install

```sh
curl -fsSL https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh | sh
```

Or `brew install martinptielemans/tap/fleetx`, or `nix run github:MartinPTielemans/fleetx`.
T3 Fleet is one file run by Node 24 or newer. With `gh` installed, the installer
checks the download against the release's build attestation.

`t3-fleet doctor` checks the machine first: Node, git, gh, `~/.local/bin` on
PATH, and whether a sync timer would run here.

## 2. Start a fleet on this machine

```sh
t3-fleet setup
```

Setup looks at what is already here and shows one screen of what it would do,
before it writes anything:

```
T3 Fleet setup  laptop  first machine: starts a fleet (~/fleet)

Pre-flight
  ✓ Node 24.13.1
  ✓ git version 2.47.1
  ✓ gh signed in as you
  ✓ ~/.local/bin is on PATH
  ✓ launchd will run the sync timer

Will add to the repo
  skill   review  from ~/.claude/skills
  skill   fmt  from ~/.claude/skills (https://github.com/acme/skills @ 24b2f6c)
  server  posthog
  server  localdb  this machine only: listens on this machine (localhost)
  server  t3-fleet  (T3 Fleet's own, for agents in T3)
  file    ~/.claude/CLAUDE.md → instructions/claude/CLAUDE.md

Will link (what is there now moves to ~/.local/state/t3-fleet/setup/backup)
  ~/.agents/skills/review → ~/fleet/skills/review
  ~/.claude/skills/review → ~/.agents/skills/review
  …

Conflicts (each is asked next; the default is first)
  skill demo: 2 different copies on this machine: use the copy in ~/.agents/skills

Left alone
  skill plug (~/.claude/skills/plug): a Claude plugin's; Claude's plugin system keeps it
  Claude Code 2.1.288: installed by native installer at ~/.local/bin/claude; setup never installs or upgrades agent CLIs

Secrets (encrypted into the repo; never in plain text)
  POSTHOG_TOKEN  phx…  posthog: header Authorization

Optional extras (each asked next; skippable)
  relay        an always-on machine gives instant sync and holds your MCP logins
  model proxy  retries, stats, a login that doesn't expire
  T3 access    provider logins and health as T3 itself sees them

Repository  gh repo create you/t3-fleet --private
```

What it finds:

- **Skills** in `~/.agents/skills`, `~/.claude/skills` and `~/.codex/skills`.
  Two copies of one skill that differ are a choice, never first-found-wins. A
  skill cloned with git is copied without its `.git` and recorded in
  `skills/SOURCES.json` (its URL, its path there, the commit), and a clone
  holding several skills gives each of them. Plugin skills stay with Claude's
  plugin system; Codex's `.system` skills are never touched.
- **MCP servers** in Claude and Codex, Claude's project servers too. Every
  credential goes into the encrypted secrets file under its own name, wherever
  it was: a header, an env value, a URL's query or password, the argument after
  `--api-key`. A Codex `bearer_token_env_var` is read from the environment, or
  asked for. A server on localhost, or run from outside your home directory,
  is this machine's only; a project's server is declared in the repo and
  registered nowhere until a machine lists it. An app's own server (a
  command inside a `.app`), a server Codex has disabled, one still waiting
  for a value, and one whose credential cannot be separated are left alone:
  listed in this machine's `[mcp] "ignore.add"`, never written to the repo.
- **Instructions**: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.agents/AGENTS.md`.
- **T3 and the agent CLIs**: reported only. Setup never installs or upgrades
  Claude Code or Codex; later syncs follow `[fleet] apply` as they always have.

Then it creates the repository (`gh repo create <you>/t3-fleet --private` when
gh is signed in; `--github owner/name` for another name, `--remote <url>` for
an empty repository elsewhere, or local only, with the next step shown),
encrypts the secrets, commits and pushes, links skills and instructions into
place, installs the sync timer when pre-flight says it will run, declares T3
Fleet's own MCP server, and syncs once.

`--plan` shows the plan and stops; it never writes anything. `--yes` takes
every default. Without gh or `--remote`, the fleet stays local and setup
finishes there, saying how to add a remote later. Before it changes
anything, setup keeps a snapshot of your clients' MCP servers and every
path it replaces with a link (`~/.local/state/t3-fleet/setup/before.json`),
so `t3-fleet leave` can give the machine back what it had.

Once you confirm, the whole run is decided and saved (its secret values
encrypted to this machine's key), so a setup that fails part-way says where,
and `t3-fleet setup --resume` does exactly what was decided from there
(`--resume --plan` shows what is left; `--abandon` drops it). `--abandon`
says what the run had already done and how to undo it; what it did stays, and
the next `t3-fleet setup` finishes it: it publishes (or proposes) the files
the run wrote, and runs the first sync that registers its servers.

The fleet's secrets are encrypted in the repo. Each machine keeps the values in
`~/.config/t3-fleet/secrets.env` (mode 600). Claude keeps the ones its servers
use in its own config, `~/.claude.json`, and in the rolling backups it makes of
it (`~/.claude/backups/`); T3 Fleet keeps all of those at mode 600
(`mcp-claude-config-exposed`).

## 3. Add a second machine

On the first machine:

```sh
t3-fleet invite desktop
```

It prints one line. Run it on the new machine:

```sh
curl -fsSL …/install.sh | sh -s -- setup https://github.com/you/t3-fleet.git desktop
```

The new machine shows its own plan against the fleet: what the fleet already
has, what this machine would add, and each difference with a diff. The
defaults:

| difference                        | default                                                     | or                                                 |
| --------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| a skill of the same name          | keep mine and propose it (the fleet's stays until approved) | use the fleet's; keep both, mine as `name@desktop` |
| an MCP server or instruction file | keep mine and propose it                                    | use the fleet's; keep mine on this machine only    |

A member never commits to the branch: what it adds is proposed, its secrets
encrypted for the authorities. Approving merges only the secrets the fleet's
definitions use, never a name like `PATH` or `NODE_OPTIONS`, and never a
different value for a name the fleet has. Two machines joining at once can
both add servers: their additions to `t3-fleet.toml` are merged. On the
first machine:

```sh
t3-fleet review            # each proposal, with its files
t3-fleet approve desktop   # applies it, and merges the secrets it proposed
```

The authority's next sync adds the new machine's key, and from then on it reads
the fleet's secrets. Its MCP servers are registered once it can.

Running `t3-fleet setup` again on a machine that is set up is safe: it shows what
still differs from the fleet (a skill installed since, say), and nothing else.
Where this machine's copy differs, the default is the fleet's. An MCP server
added since is left alone (`[mcp] "ignore.add"`) unless you choose to add it to
the fleet.

`t3-fleet approve` merges a proposal only where it adds: servers to the lists in
t3-fleet.toml, `[[defaults.instructions]]` entries, whole new tables. A proposal
that removes or changes something the fleet changed since is refused; reject it,
and the machine's next sync sets its edit aside, so `t3-fleet setup` there can
offer it again.

## 4. Use it from T3 Code

Setup declares T3 Fleet's own MCP server (`t3-fleet mcp`), so any thread on any
machine can be asked "what's wrong with my environments?". The tools are
`fleet_status`, `fleet_apply_fixes` and `fleet_alerts`.

Or open it in a browser:

```sh
t3-fleet ui
```

Every view the CLI has, live: environments, findings and fixes, proposals,
alerts, skills, the MCP hub, models, and each machine's config.

## What happens from here

Every machine runs `t3-fleet sync` on a timer: it pulls the repository, converges,
and publishes its state. Changes a machine makes under `[fleet] auto_commit`
paths (new skills, say) are proposed for an authority: `t3-fleet review` shows
each proposal with its commit, and `t3-fleet approve <node> <commit>` applies
what it changed on top of whatever the branch has now.
`t3-fleet status --all` shows every machine from their published state without
contacting any of them.

Next: [topologies](topologies.md), [areas](areas.md), [troubleshooting](troubleshooting.md).

## Leaving

```sh
t3-fleet leave --dry-run   # see what it would do
t3-fleet leave             # do it, after asking
```

`leave` takes this machine out of the fleet and leaves it working on its own.
It stops T3 Fleet's timer and services, turns its links (skills, dotfiles,
instructions) into real copies, points T3's providers back at what they ran
before, and puts back the MCP servers Claude and Codex had before setup. Entries
you changed yourself since are left alone. An authority removes itself (unless
no other authority would be left); a member proposes its departure, and an
authority approves it with `t3-fleet approve`. `--purge` also removes this
machine's key, the decrypted secrets and the installed `t3-fleet`, keeping
backups of your own files. If leaving stops partway, run it again: it picks up
where it stopped. The config repo checkout is never deleted.
