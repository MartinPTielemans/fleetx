# Plan

What fleetx becomes, in phases. Each phase ends at a check a person can run.
Ticked items are done and in `main`.

## Principles

1. Declared, observed, converged: every area observes, plans, applies.
2. Git alone is enough; a relay only adds speed.
3. Machines propose, authorities decide.
4. A fixed runtime environment, never inherited from a login shell.
5. Failures are visible; a node that goes quiet counts as failing.
6. Engine and config are separate: the engine is public, a user's setup is
   their own private repository.

## Phase 0: design

- [x] Topology as configuration: roles (authority, relay, member) on nodes
- [x] Stack matches T3 Code (TypeScript, Effect 4, Node 24, pnpm, vite-plus)
- [x] T3 contracts vendored at a pinned commit
- [x] Config format: TOML; `~/.config/fleetx/config.toml` points at the user's repo
- [ ] Area interface: observe → plan → apply → capture

## Phase 1: core

- [x] Probe: T3 server, providers under the server's environment, agent CLIs, proxy
- [x] `status`, `status --json`, `status --changes`
- [x] `fix` with plan, confirmation, disruption marking, re-check
- [x] MCP server (`fleet_status`, `fleet_apply_fixes`) for T3 threads
- [x] Accepted differences (`[[accept]]`)
- [x] Engine contains no personal data (checked in tests and CI)
- [ ] `fleetx` installable as a command (`npx fleetx`); a local link to the build works today
- [ ] Profiles (`profiles/*.toml`) and roles on nodes; `config show <node>` with provenance
- [ ] Fixed runtime: one environment for timer, T3 and shell; `fleetx doctor`
- [ ] Area: agents (install and upgrade Claude Code and Codex per version policy)
- [ ] Area: t3 (server on a channel, service installed, providers' binaries)
- [ ] Area: dotfiles (links and rendered templates)

## Phase 2: git sync

- [ ] `fleet/state` branch: each node writes its own health file
- [ ] `fleet/staging` branch: adopted skills and captured edits as proposals
- [ ] `sync`: observe, propose, pull, apply safe, report, alert
- [ ] Timers (launchd, systemd user and system units)
- [ ] `review`, `approve`, `reject`; auto-approve rules
- [ ] `status --all` from `fleet/state`, without ssh
- [ ] Alerts on health transitions, delivered to a T3 thread
- [ ] `init`, `invite`, `join`

## Phase 3: remaining areas

- [ ] Area: skills (vendored store, client links, adoption into staging)
- [ ] Area: instructions (CLAUDE.md, AGENTS.md, layered)
- [ ] Area: mcp (definitions, client registration, live checks; local mode)
- [ ] Area: secrets (age, one recipient per node; `secrets add-node`)
- [ ] Area: services (report only)
- [ ] Converter from bash fleet `hosts/*.json` to `nodes/` and `profiles/`

## Phase 4: relay

- [ ] `relay serve`: report endpoint, event stream, current state
- [ ] "pull now" events on new commits; missed-event queue for sleeping nodes
- [ ] MCP gateway mode on the relay node

## Phase 5: for others

- [ ] Signed releases; `npx fleetx`, Homebrew, `curl | sh`, Nix flake
- [ ] Area plugin API
- [ ] Integration tests with throwaway container nodes in CI
- [ ] Docs: quickstart, one recipe per topology, troubleshooting from `doctor`

## Migration (the author's own fleet)

- [x] fleetx checks all machines alongside the bash fleet
- [ ] omarchy on fleetx alone for a week
- [ ] box (also the relay) and mac switched; bash engine retired
