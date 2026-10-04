# Quickstart

Five minutes from one machine to two.

## 1. Install

```sh
curl -fsSL https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh | sh
```

Or `brew install martinptielemans/tap/fleetx`, or `nix run github:MartinPTielemans/fleetx`.
T3 Fleet is one file run by Node 24 or newer. With `gh` installed, the installer
checks the download against the release's build attestation.

## 2. Start a fleet from this machine

```sh
t3-fleet init --github you/fleet
```

`init` looks at what is already here (Claude Code, Codex, T3 Code, skills, MCP
servers, CLAUDE.md, AGENTS.md) and writes a config repository from it, with this
machine as the authority. It copies and reads; it changes nothing on the
machine. Tokens it finds in MCP configuration go into an encrypted secrets file,
never into plain files. `--github` creates the private repository and pushes.

```sh
t3-fleet status        # every machine: T3, the providers it launches, agent CLIs
t3-fleet fix           # apply what status suggests, after showing it
```

## 3. Add a second machine

On the first machine:

```sh
t3-fleet invite desktop
```

It prints a command. Run it on the new machine:

```sh
curl -fsSL …/install.sh | sh -s -- join https://github.com/you/fleet.git desktop
```

The new machine clones the repository, creates its own key, installs its sync
timer, and converges. The authority's next sync lets it read the secrets.

## 4. Use it from T3 Code

```sh
claude mcp add T3 Fleet -- t3-fleet mcp
```

Any thread can now be asked "what's wrong with my environments?". The tools are
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
