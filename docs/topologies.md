# Topologies

Topology is configuration. Every node has one or more roles:

| role        | does                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `authority` | approves proposals, changes secrets; its own changes under `auto_commit` paths are committed directly |
| `relay`     | runs `t3-fleet relay serve`: events, published state, the MCP hub (optional)                          |
| `member`    | converges, reports, proposes                                                                          |

Git is always the hub. A relay only makes things faster.

You don't have to choose a layout by hand. The [setup wizard](design/setup-wizard.md)
asks what machines you have and recommends one: your own computer as the
authority, an always-on machine as the hub. It checks that machine over ssh
from your computer and sets it up, so you don't run setup on it yourself.
`t3-fleet setup` does the same in the terminal.

## One laptop

```toml
# nodes/laptop.toml
roles = ["authority"]
```

`t3-fleet setup` on the first machine writes exactly this. The repository is
backup, history, and the place your skills and MCP servers are declared.

## Laptop and an always-on server

Why: every other machine syncs on its timer (every 15 minutes) and only
learns of a change when it next pulls. A relay tells them the moment the
branch moves, keeps the state of machines that are asleep, and can host your
MCP servers, so an OAuth login happens once, there, instead of on every
machine.

Run setup on the server and say yes to the relay (or pass `--relay`):

```sh
t3-fleet setup https://github.com/you/t3-fleet.git server --relay
```

It checks that tailscale runs there (other machines reach the relay on the
tailnet) and that docker does (the hub runs container servers with it), and
proposes:

```toml
# nodes/server.toml
roles = ["member", "relay"]

# t3-fleet.toml
[relay]
url = "https://server.tailnet.ts.net:8399"
port = 8399
```

with a new `T3_FLEET_RELAY_TOKEN` among the secrets it proposes. Once an
authority approves, the relay area installs `t3-fleet relay serve` on the
server and publishes it on the tailnet; every other node runs `t3-fleet listen`
and syncs seconds after the branch moves. A laptop that slept catches up on
the events it missed. Without tailscale, set `[relay] url` once the server
can be reached.

### The MCP hub

Why: an MCP server with an OAuth login otherwise needs that login on every
machine, and a server run in docker needs docker everywhere. The relay can
host your MCP servers instead, so every machine reaches them through one
endpoint and one token, and OAuth logins live in one place:

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

## A model proxy

Why: a provider request that fails with a 429 or a 529 is retried before the
CLI ever sees it, every machine keeps stats per upstream (`t3-fleet models
stats`), and Claude uses a login that does not expire. Say yes to the model
proxy during setup (or pass `--models`): it writes

```toml
# t3-fleet.toml
[defaults.models]
egress = "direct"
```

and asks for the token `claude setup-token` prints, stored as the secret
`CLAUDE_CODE_OAUTH_TOKEN`. See [areas](areas.md#models).

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

Members are invited and set up like any machine (`t3-fleet invite`, then
`t3-fleet setup <repo-url> <name>` there), and removed by deleting their node
file.

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
