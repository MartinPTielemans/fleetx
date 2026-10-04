# Topologies

Topology is configuration. Every node has one or more roles:

| role        | does                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `authority` | approves proposals, changes secrets; its own changes under `auto_commit` paths are committed directly |
| `relay`     | runs `t3-fleet relay serve`: events, published state, the MCP hub (optional)                          |
| `member`    | converges, reports, proposes                                                                          |

Git is always the hub. A relay only makes things faster.

## One laptop

```toml
# nodes/laptop.toml
roles = ["authority"]
```

`t3-fleet init` writes exactly this. The repository is backup, history, and the
place your skills and MCP servers are declared.

## Laptop and an always-on server

```toml
# nodes/laptop.toml
roles = ["authority"]

# nodes/server.toml
roles = ["relay", "member"]
ssh = "server"

# t3-fleet.toml
[relay]
url = "https://server.tailnet.ts.net:8399"
port = 8399
```

Add the relay token once: `t3-fleet secrets set T3_FLEET_RELAY_TOKEN=$(openssl rand -hex 32)`.
The relay area installs `t3-fleet relay serve` on the server and publishes it on
the tailnet; every other node runs `t3-fleet listen` and syncs seconds after the
branch moves. A laptop that slept catches up on the events it missed.

### The MCP hub

The relay can host your MCP servers too, so every machine reaches them through
one endpoint and one token, and OAuth logins live in one place:

```toml
# t3-fleet.toml
[defaults.mcp]
hub = true
gateway = "https://server.tailnet.ts.net:8399"
servers = ["fetch", "posthog"]
```

The hub runs every definition in `mcp/` with a hosted kind (`remote`,
`container`, `registry`, `hosted-stdio`) on the relay node, with Docker for
images. Sign in to OAuth servers once with `t3-fleet mcp login <name>`; the
callback goes to the relay, so it works from any browser on the tailnet. See
[areas](areas.md#the-hub).

Without the hub, servers hosted elsewhere on the server (ToolHive, say) can
still be reached through the relay's gateway by port:

```toml
[defaults.mcp]
gateway = "https://server.tailnet.ts.net:8399"
ports = { fetch = 18100 }      # where each hosted server listens on the server
```

### Moving from ToolHive to the hub

1. Set `hub = true` and `gateway` in `[defaults.mcp]`; `ports` and `origin`
   are no longer needed. Sync: clients are re-registered at
   `<gateway>/mcp/<name>`.
2. `t3-fleet mcp servers` shows which servers need a sign-in; run
   `t3-fleet mcp login <name>` for each.
3. `t3-fleet status` reports `mcp-toolhive-left` on machines where ToolHive
   still runs those servers; `t3-fleet fix --area mcp` stops them.

## Two laptops, no server

```toml
# nodes/laptop.toml and nodes/desktop.toml
roles = ["authority"]
```

Both can approve. Both may sleep; git is the hub, and each syncs on its timer.

## Cloud only

```toml
# nodes/vps.toml
roles = ["authority", "relay"]

# nodes/sandbox-1.toml (and so on, short-lived)
roles = ["member"]
```

Members are invited and joined like any machine, and removed by deleting their
node file.

## Shared settings

Put what several nodes share in a profile and list it:

```toml
# profiles/workstation.toml
[skills]
clients = ["~/.claude/skills"]

# nodes/laptop.toml
profiles = ["workstation"]

[skills]
"ignore.add" = ["something-local"]
```

Layers apply in order: `[defaults]` in t3-fleet.toml, then each profile, then the
node. Tables merge; lists are replaced unless a layer uses `.add` or `.remove`.
`t3-fleet config show <node>` prints the result and where each value came from.
