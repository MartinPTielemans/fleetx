# Topologies

Topology is configuration. Every node has one or more roles:

| role | does |
|---|---|
| `authority` | approves proposals, changes secrets; its own changes under `auto_commit` paths are committed directly |
| `relay` | runs `fleetx relay serve`: events, published state, the MCP gateway (optional) |
| `member` | converges, reports, proposes |

Git is always the hub. A relay only makes things faster.

## One laptop

```toml
# nodes/laptop.toml
roles = ["authority"]
```

`fleetx init` writes exactly this. The repository is backup, history, and the
place your skills and MCP servers are declared.

## Laptop and an always-on server

```toml
# nodes/laptop.toml
roles = ["authority"]

# nodes/server.toml
roles = ["relay", "member"]
ssh = "server"

# fleetx.toml
[relay]
url = "https://server.tailnet.ts.net:8399"
port = 8399
```

Add the relay token once: `fleetx secrets set FLEETX_RELAY_TOKEN=$(openssl rand -hex 32)`.
The relay area installs `fleetx relay serve` on the server and publishes it on
the tailnet; every other node runs `fleetx listen` and syncs seconds after the
branch moves. A laptop that slept catches up on the events it missed.

To reach MCP servers hosted on the server through one endpoint:

```toml
[defaults.mcp]
gateway = "https://server.tailnet.ts.net:8399"
ports = { fetch = 18100 }      # where each hosted server listens on the server
```

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

Layers apply in order: `[defaults]` in fleetx.toml, then each profile, then the
node. Tables merge; lists are replaced unless a layer uses `.add` or `.remove`.
`fleetx config show <node>` prints the result and where each value came from.
