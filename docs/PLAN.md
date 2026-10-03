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
- [x] Area interface: observe on the node, diagnose with the whole fleet, fixes as plans

## Phase 1: core

- [x] Probe: T3 server, providers under the server's environment, agent CLIs, proxy
- [x] `status`, `status --json`, `status --changes`
- [x] `fix` with plan, confirmation, disruption marking, re-check; `--area`, `--safe`
- [x] MCP server (`fleet_status`, `fleet_apply_fixes`, `fleet_alerts`) for T3 threads
- [x] Accepted differences (`[[accept]]`)
- [x] Engine contains no personal data (checked in tests and CI)
- [x] Installable: `curl | sh` (attestation-verified), Homebrew tap, Nix flake;
      npm publishing is wired and runs once an `NPM_TOKEN` secret is set
- [x] Profiles and roles on nodes; `config show <node>` with provenance
- [x] Fixed runtime: units run an upgrade-proof node and absolute bundle with a fixed PATH; `doctor`
- [x] Agents: install and upgrade Claude Code and Codex; policy track, pin, manual
- [x] T3: version against channel, `[t3] channel`, service check, providers' binaries
- [x] Area: dotfiles

## Phase 2: git sync

- [x] `fleetx/state/<node>` branches: each node publishes its own state
- [x] `fleetx/staging/<node>` branches: proposals; rejections set aside on the node
- [x] `sync`: propose, pull (refusing real overlaps), converge, report, alert; config reloaded after pulling
- [x] Timers (launchd, systemd user and system units)
- [x] `review`, `approve`, `reject`; `[fleet] auto_approve`
- [x] `status --all` from published state, without ssh
- [x] Alerts on health transitions, delivered to a T3 thread (`fleet_alerts`, scheduled)
- [x] `init`, `invite`, `join`

## Phase 3: remaining areas

- [x] skills: vendored store, client links, strays adopted; `skills add/update/remove` with provenance
- [x] instructions: CLAUDE.md, AGENTS.md, client config linked from the repo
- [x] mcp: definitions, Claude and Codex registration, live `initialize` checks; `mcp add`
- [x] secrets: age, one recipient per node, no binary needed; `secrets add-node` automatic through the authority's sync
- [x] services: reported, never deployed; capture into the repo
- [x] codex: Codex plugins per node
- [x] Converter from a bash fleet's `hosts/*.json` (kept in the author's private repo; done)

## Phase 4: relay

- [x] `relay serve`: report endpoint, event stream, current state; tailnet only, token auth
- [x] "pull now" events on new commits; missed-event replay for sleeping nodes; `listen`
- [x] MCP gateway mode on the relay node

## Phase 5: for others

- [x] Attested releases (`gh attestation verify`); install script, Homebrew, Nix
- [x] Area plugin API (`[plugins] areas`, a kit instead of imports), with an example
- [x] Integration tests with throwaway container nodes in CI
- [x] Docs: quickstart, topologies, areas, troubleshooting kept complete by a test

## Phase 6: companion (docs/design/companion.md)

- [x] `fleetx ui`: a local web app in T3's look, embedded in the bundle; token,
      Host and Origin checks; live through server-sent events
- [x] models: a pass-through model proxy on every node with configurable
      upstreams, launchers per T3 provider instance, long-lived credentials
      per provider; login and health of every T3 provider from T3 itself
- [x] hub: fleetx's own MCP hub on the relay, replacing ToolHive: containers,
      stdio bridge, OAuth with sign-in through the relay, client tokens,
      tool policy, call log
- [x] Security review before deploy; its must-fix items fixed
- [ ] The author's fleet on the hub and the model proxy

## Migration (the author's own fleet)

- [x] fleetx checks all machines alongside the bash fleet
- [ ] omarchy on fleetx alone for a week (switched on 2026-10-03 together with
      the others; the week has not passed yet)
- [x] box (also the relay) and mac switched: bash timers and workstation
      ToolHive proxies off, MCP through the relay's gateway
- [ ] Bash engine code removed from the private repo (timers already off;
      deleting the files is left to its owner)
