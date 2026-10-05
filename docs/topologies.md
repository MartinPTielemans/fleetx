# Topologies

Topology is configuration. Every node has one or more roles:

| role        | does                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `authority` | approves proposals, changes secrets; its own changes under `auto_commit` paths are committed directly |
| `relay`     | runs `t3-fleet relay serve`: events, published state, the app on the tailnet, the MCP hub (optional)  |
| `member`    | converges, reports, proposes                                                                          |

Git is always the hub. A relay only makes things faster.

With `[notify]`, the relay delivers ntfy pushes for every node. Nodes listed in
`desktop` display fleet OS notifications through their listener. Without a relay,
each node delivers only its own alerts after sync. A returning laptop receives at
most a summary of missed alerts per path. No agent or scheduled T3 thread is
required. See [notifications](areas.md#notifications).

You don't have to choose a layout by hand. The [setup wizard](design/setup-wizard.md)
asks what machines you have and recommends one: your own computer as the
authority, an always-on machine as the hub. It checks that machine over ssh
from your computer and sets it up, so you don't run setup on it yourself.
Only the wizard brings the hub up over ssh, and it is done only once the relay
answers there. In the terminal, `t3-fleet setup` sets up the machine it runs
on: run it on the server with `--relay`, as below; the authority that approves
it lets its own Tailscale login into the app the hub hosts (`[ui] allow`).

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
authority approves, each machine's own sync does the rest, as it keeps
anything else the fleet's: the relay area is among the areas sync always
applies (with `[fleet] apply` set, setup adds `relay` to it), so the server's
next sync installs `t3-fleet relay serve` and publishes it on the tailnet, and
every other machine's runs `t3-fleet listen` and syncs seconds after the
branch moves. A machine starts its service as soon as it can read the relay
token; one sync goes as far as that (it reads the secrets, then starts the
service). A laptop that slept catches up on the events it missed. Without
tailscale, set `[relay] url` once the server can be reached.

### The app on the hub

The relay also serves T3 Fleet's web app, at its tailnet address, to the
Tailscale logins in `[ui] allow` (setup writes yours); `t3-fleet ui` opens it
there. It is built from what machines report, sends each fix to the machine
it changes, and never decides proposals. See [the CLI](cli.md#on-the-hub).

What the hub can and cannot do, should it be compromised: it can read what
machines report (no secret values: a fix whose command holds one is not
reported, and outputs have them taken out in full before anything is cut
short), and ask any machine for fixes, but a machine runs only a fix its own
check proposes, exactly as it would propose it, and its interruption
confirmed, once per request. It cannot approve a proposal, its own or
another's, and setting it up approves nothing of its own but its proposed
secrets: a change to its node file (a role, a profile, a setting) waits for
you like any proposal. It holds the relay token, like every machine, so it
could publish false reports. Only tailscale serve can say who is asking, so
the relay asks the hub's kernel whose socket opened each connection to its
loopback port, and refuses any other program on the hub, the relay's own user
included:

| Hub                                                                                   | Serves the app to                                                                           |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Linux                                                                                 | connections of root's, or of the user tailscaled runs as (`/proc/net/tcp`)                  |
| macOS, the standalone Tailscale app (system extension, root)                          | connections of root's (the kernel's TCP table, `net.inet.tcp.pcblist_n`)                    |
| macOS, open-source `tailscaled` as a daemon (`sudo tailscaled install-system-daemon`) | connections of root's                                                                       |
| macOS, the App Store Tailscale app (its extension runs as you)                        | the extension's own connections only, by its code signature, checked on the running process |
| macOS with `tailscaled` run as a user; any other OS                                   | no one: setup writes `[ui] hosted = false` and `t3-fleet ui` serves the app on each machine |

Root on the hub is out of reach of any of this. If the hub is also an
authority (one machine doing both), it can commit to the repo anyway, as any
authority can.

### The MCP hub

Why: an MCP server with an OAuth login otherwise needs that login on every
machine, and a server run in docker needs docker everywhere. The relay can
host your MCP servers instead, so every machine reaches them through one
endpoint and one token, and OAuth logins live in one place.

It is a choice, off by default: "Host your MCP servers on the hub" on the
wizard's hub step, or `--mcp-hub` with `--relay` in the terminal. The trade-off:
you sign in to each server once, on the hub, and every machine uses it; until
you sign in there, those servers stop working on your machines. On, setup
writes:

```toml
# t3-fleet.toml
[defaults.mcp]
hub = true
gateway = "https://server.tailnet.ts.net:8399"
servers = ["fetch", "posthog"]
```

The hub runs every definition in `mcp/` with a hosted kind (`remote`,
`container`, `registry`, `hosted-stdio`) on the relay node, with Docker for
images. Turning it on moves the servers it can take over: each plain https
server (`direct`, as setup imports them) becomes `remote`, its bearer secret
kept. A server that runs a command (`stdio`), sends headers of its own, speaks
SSE, or carries a secret in its URL stays on each machine, as before. The plan
lists which servers move and which stay, and why, before anything is written. Sign in to OAuth servers once with `t3-fleet mcp login <name>`; the
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
