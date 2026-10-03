# Areas

An area is one kind of thing fleetx keeps equivalent. Each observes the
machine read-only, diagnoses against what the node's settings say (and what the
other nodes look like), and proposes fixes. `fleetx sync` runs a fix unattended
only when it is marked safe and its area is in `[fleet] apply`.

Settings below go in a node file, a profile, or `[defaults]` in fleetx.toml.

## Built in, always on

**T3 and providers.** The running T3 server's version against its release
channel; each enabled provider launched with the T3 server's own environment.
`[t3] channel = "nightly"` makes a node follow a channel.

**Agent CLIs.** Claude Code (native installer, `~/.local/bin/claude`) and Codex
(npm under `~/.local`). `[agents.claude] policy = "track"` (default),
`"pin:2.1.288"`, or `"manual"`.

**Proxy.** If `[proxy]` is declared in fleetx.toml: whether each node's key is
accepted, and which providers skip the launcher. See the README.

## runtime

What fleetx and T3 run on: Node 24+, fleetx's own git config, the config
repo's remote reachable without a terminal, `~/.local/bin` on PATH.
`fleetx doctor` shows only this area.

## engine

This build of fleetx installed on every node, the node's
`~/.config/fleetx/config.toml`, and the sync timer:

```toml
[engine]
timer = true
interval = 900
```

## secrets

Every node can read the fleet's secrets and has the current ones.
`fleetx secrets set KEY=VALUE` on an authority; nodes pick them up on sync.

## relay

With `[relay]` in fleetx.toml: the relay service on the node with the relay
role (published to the tailnet), and a listener on every other node.

## dotfiles

```toml
[[dotfiles]]
src = "zshrc"          # in the repo's dotfiles/
dest = "~/.zshrc"
```

A different file already at `dest` is moved to `dest.fleetx-backup.<time>`.

## instructions

Like dotfiles, but `src` is relative to the repo root:

```toml
[[instructions]]
src = "claude/CLAUDE.md"
dest = "~/.claude/CLAUDE.md"
```

## skills

```toml
[skills]
store = "~/.agents/skills"       # links into the repo's skills/
clients = ["~/.claude/skills"]   # links into the store
watch = ["~/.codex/skills"]      # only checked for stray installs
ignore = ["synced"]
```

A skill installed outside fleetx is a stray: `fleetx skills adopt` moves it
into the repo, where sync commits (authority) or proposes it.

## mcp

```toml
[mcp]
servers = ["fetch", "context7"]          # registered in Claude and Codex
origin = "server.tailnet.ts.net"         # host serving hosted servers
ports = { fetch = 18100 }
gateway = "https://server.tailnet.ts.net:8399"   # optional: through the relay
```

Each server is defined once in the repo's `mcp/<name>.json` (`kind`: `stdio`,
`direct`, or a hosted kind; `auth = { type = "bearer", token_env = "NAME" }`).
Every registered HTTP server gets an `initialize` request as a live check.

## services

```toml
services = ["web"]
```

Docker Compose stacks, reported only: running or not, and whether the compose
file each runs from matches the repo's `services/<name>/`. fleetx never
deploys.

## Plugins

```toml
# fleetx.toml
[plugins]
areas = ["plugins/brew.mjs"]
```

A plugin exports `(kit) => area`; see `examples/plugins/brew.mjs`.
