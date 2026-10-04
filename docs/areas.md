# Areas

An area is one kind of thing T3 Fleet keeps equivalent. Each observes the
machine read-only, diagnoses against what the node's settings say (and what the
other nodes look like), and proposes fixes. `t3-fleet sync` runs a fix unattended
only when it is marked safe and its area is in `[fleet] apply`.

Settings below go in a node file, a profile, or `[defaults]` in t3-fleet.toml.

## Built in, always on

**T3 and providers.** The running T3 server's version against its release
channel; each enabled provider launched with the T3 server's own environment.
`[t3] channel = "nightly"` makes a node follow a channel.

**Agent CLIs.** Claude Code (native installer, `~/.local/bin/claude`) and Codex
(npm under `~/.local`). `[agents.claude] policy = "track"` (default),
`"pin:2.1.288"`, or `"manual"`.

**Proxy.** If `[proxy]` is declared in t3-fleet.toml: whether each node's key is
accepted, and which providers skip the launcher. See the README.

## runtime

What T3 Fleet and T3 run on: Node 24+, T3 Fleet's own git config, the config
repo's remote reachable without a terminal, `~/.local/bin` on PATH.
`t3-fleet doctor` shows only this area.

## engine

This build of T3 Fleet installed on every node, the node's
`~/.config/t3-fleet/config.toml`, and the sync timer. Only a newer build is
installed: a node ahead of the controller is reported (`engine-newer-here`),
never downgraded. A node that already has the controller's exact build runs
its own copy for checks, so the bundle is only sent to the others.

```toml
[engine]
timer = true
interval = 900
```

## secrets

Every node can read the fleet's secrets and has the current ones.
`t3-fleet secrets set KEY=VALUE` on an authority; nodes pick them up on sync.
A new node's key is added once, by the authority's sync; until the node
pulls, later syncs see it can already read the file and commit nothing.
`secrets/recipients.toml` records which keys the file was last encrypted to,
so a key listed without re-encrypting is never taken as able to read it.

No commit T3 Fleet makes may add a secret anywhere else: every commit, sync
proposal and approval checks the lines it adds for tokens, passwords in URLs
and private keys, and refuses, naming the file and line but never the value.
See `sync-secret-<unit>` in troubleshooting.md for letting a false positive
through with `t3-fleet secrets allow`.

## relay

With `[relay]` in t3-fleet.toml: the relay service on the node with the relay
role (published to the tailnet), and a listener on every other node. Neither
service is offered before the machine has the relay token; on the relay node,
status also says when Tailscale or Docker (for `container` and `registry` hub
servers) is missing. A
listener that reconnects gets the events it missed; when the relay cannot
know what that was (it restarted since), the listener gets a "pull" and
syncs.

## dotfiles

```toml
[[dotfiles]]
src = "zshrc"          # in the repo's dotfiles/
dest = "~/.zshrc"
```

A different file already at `dest` is moved to `dest.t3-fleet-backup.<time>`.

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

A skill installed outside T3 Fleet is a stray: `t3-fleet skills adopt` moves it
into the repo, where sync commits (authority) or proposes it.

A real directory where a skill's link belongs (the machine had its own copy
before joining) is moved to `~/.local/state/t3-fleet/skill-backups/<time>/`,
outside every directory checked for strays. Backups an older T3 Fleet left
beside a skill (`<name>.t3-fleet-backup.<time>`) are never taken for skills,
and `skills adopt` refuses them.

`t3-fleet skills add|update|remove` vendor skills from git repositories, with
their provenance in `skills/SOURCES.json`. The Skills view in `t3-fleet ui` does
the same, and shows each skill's links on every machine.

## mcp

```toml
[mcp]
servers = ["fetch", "context7", "posthog"]       # registered in Claude and Codex
hub = true                                       # the relay's MCP hub serves hosted kinds
gateway = "https://server.tailnet.ts.net:8399"   # the relay
token_env = "T3_FLEET_MCP_TOKEN_LAPTOP"            # optional: a client token instead of the relay token
```

Each server is defined once in the repo's `mcp/<name>.json`. Its `kind`
decides where clients connect:

| kind                                              | clients connect to                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `stdio`                                           | `command` with `args`, run on the node itself                           |
| `direct`                                          | `url` (`auth = { type = "bearer", token_env = "NAME" }` sends a secret) |
| `remote`, `container`, `registry`, `hosted-stdio` | the hub: `<gateway>/mcp/<name>`, with the relay token or `token_env`    |

Every registered HTTP server gets an `initialize` request as a live check.

Without the hub, hosted servers run elsewhere and need a port each:
`origin = "server.tailnet.ts.net"` and `ports = { fetch = 18100 }` (clients
connect to `http://<origin>:<port>/mcp`, or through the relay's gateway when
`gateway` is set too).

### The hub

With `hub = true` on the relay node, `t3-fleet relay serve` runs every hosted
definition in `mcp/` and serves it at `<relay url>/mcp/<name>`:

| kind           | the hub                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `remote`       | proxies to `url` (https; plain http only on loopback), adding the server's credential (OAuth, or a bearer secret)           |
| `container`    | runs `image` with Docker on a port from 18200–18299 and proxies to it (`target_port`, default 8080; `path`, default `/mcp`) |
| `registry`     | the same; `transport = "stdio"` (the default for registry) images are bridged                                               |
| `hosted-stdio` | runs `command` on the relay node and bridges it                                                                             |

Containers are named `t3-fleet-mcp-<name>`, run with `--cap-drop ALL
--security-opt no-new-privileges`, publish only on 127.0.0.1, get `env` from
the fleet's secrets (`env = { API_KEY = "$CONTEXT7_API_KEY" }`, passed in a
private env file that is removed once docker has read it), and can be
cut off with `network = "none"` (stdio images). The hub adopts a matching
running container after a restart and restarts one that dies, with backoff.
One stdio process serves every client: the bridge gives each its own session,
and a session belongs to the client token that opened it (one the hub has no
record of is refused; owners of proxied servers' sessions are kept across
relay restarts). At 1000 sessions a new one replaces the least recently used
idle one, so clients that never close theirs cannot lock others out; a session
without an open event stream also ends after a day unused. The hub checks
every server each minute; a process or container that misses three checks in
a row, while no client request is in flight, is restarted.

Optional fields in a definition:

```json
{
  "remote_auth": true,
  "remote_auth_scopes": ["openid", "query:read"],
  "oauth": { "client_id": "…", "client_secret_env": "NAME", "issuer": "https://auth.example.com" },
  "tools": { "deny": ["delete_*"] }
}
```

`remote_auth` asks for an OAuth login up front; a server that answers 401 is
detected anyway. The hub registers itself with the authorization server
when it allows dynamic registration; otherwise register a client there with
the redirect URI `<relay url>/oauth/callback` and add `oauth`, naming the
issuer it is registered with: its secret is never sent to any other. The hub
checks that the authorization server's metadata names its own issuer and that
the resource metadata is for this server. Fields written
for ToolHive (callback ports, timeouts, registry references) are ignored.

Sign in once, from any machine: `t3-fleet mcp login <name>` prints the URL to
open in any browser on the tailnet and waits for that sign-in to finish. The
hub keeps the tokens encrypted to the relay node's key
(`~/.local/state/t3-fleet/hub/tokens.age`) and refreshes them ahead of
expiry. A refresh the authorization server refuses loses the login, and the
server shows as needing a sign-in; when the authorization server is merely
down or busy, the hub keeps using the token until it expires and tries again
with a backoff. A login belongs to the server's URL: point the definition at
another URL and the server needs a new sign-in. `logout` also forgets the
hub's client registration, so the next login registers afresh.

```
t3-fleet mcp servers                 every hosted server and its state
t3-fleet mcp login | logout | restart <name>
t3-fleet mcp calls [--server x]      recent calls: client, method, tool, time, outcome
t3-fleet mcp token create <client> [--server x]   a gateway token for one client
t3-fleet mcp token list | revoke <client>
```

The call log never holds arguments or results. Denied tools are hidden from
`tools/list` and refused with a JSON-RPC error. A server receives only the
JSON-RPC fields of each message, and a message with a key that folds to one
the policy reads (`Name` beside `name`, `paramſ` beside `params`) is refused. Client tokens are stored only
as digests on the relay; on an authority, `token create` keeps the token in
the fleet's secrets as `T3_FLEET_MCP_TOKEN_<CLIENT>`.

## models

```toml
[models]
egress = "direct"                     # or "relay"

[models.upstreams.xai]                # beyond the built-in anthropic and openai
url = "https://api.x.ai/v1"

[models.providers.grok]               # per T3 provider instance
upstream = "xai"
env = { XAI_BASE_URL = "{proxy}" }    # {proxy} = http://127.0.0.1:8398/<upstream>
token_env = "XAI_API_KEY"             # a long-lived credential from the fleet's secrets

[models.providers.codex]
route = false                         # leave this one alone
```

A model proxy on every node, on 127.0.0.1:8398, between T3's providers and
the model providers. It serves `/<upstream>/*` for each upstream: `anthropic`
(api.anthropic.com), `openai` (the OpenAI API, or the ChatGPT backend for a
ChatGPT login), and any that `[models.upstreams.<name>]` declares (`url`,
optionally `chatgpt_url`). It is a pass-through: each CLI makes its own
requests with its own credential, and the proxy forwards them unchanged. It
retries 408, 429, 500, 502, 503, 504 and 529, and network errors from before
the request left the machine (refused, unresolvable, a connect timeout), up
to three times, only before the first byte reaches the client. It obeys
`x-should-retry`, honours `retry-after-ms` and `retry-after`, and waits 10
seconds at most in all; after that the answer goes to the CLI, which retries
on its own. A request the upstream may have received (a reset, a timeout
waiting for the answer) is never sent twice. A response that breaks off after
it started reaches the client as a dropped connection, never as a body that
ends cleanly. The proxy sends SSE keepalives while an event stream is quiet,
and keeps per-upstream stats for 5 minutes, 1 hour and 24 hours
(`t3-fleet models stats`, and the UI). It logs metadata only, to
`~/.local/state/t3-fleet/models.jsonl`; never bodies or auth headers.

Installing a new build does not cut a response: the proxy notices the build,
keeps answering until its last response is done (15 minutes at most), and
exits; its service starts the new build a second later. Stopping the service
waits up to 45 seconds the same way.

The area installs `t3-fleet models serve` as a service, writes a launcher per
enabled T3 provider instance it can route (`~/.local/bin/t3-fleet-claude`,
`t3-fleet-codex`, `t3-fleet-<instance>`), and points T3's instances at them
(`t3-fleet models route <instance>`; `--undo` reverts). A launcher follows its
instance's recipe: the variables (`env`) and leading arguments (`args`) that
point the CLI at `{proxy}`, the CLI to run (`command`), and a long-lived
credential to load from the node's secrets (`token_env`). Two recipes are
built in:

| driver      | points it at the proxy                                                     | token_env                                                         |
| ----------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| claudeAgent | `ANTHROPIC_BASE_URL={proxy}`                                               | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`; does not rotate) |
| codex       | `-c openai_base_url="{proxy}"` (keeps Codex's built-in provider and login) | none                                                              |

Any other driver whose CLI takes a base URL is routed by declaring its recipe;
one that runs inside T3 without a CLI, or has no recipe, is a note. When the
proxy is not listening a launcher runs the CLI directly and notes it in
`~/.local/state/t3-fleet/models-fallback.log`; it asks the proxy with curl,
wget or bash, whichever the machine has. A recipe's CLI under `~/` that is not
there is looked up on PATH, and T3 is only pointed at a launcher whose CLI is
installed.

With `egress = "relay"` the proxy sends traffic through the relay's `/egress`
route instead of directly, for a node on a bad network. The relay forwards
only to upstreams some node's `[models]` declares. When the relay cannot be
reached, or will not forward, the request goes direct.

Independently of `[models]`, every node reports each T3 provider's login and
health as T3 itself sees it (`provider-logged-out-<instance>`,
`provider-unhealthy-<instance>`), read with T3 Fleet's read-only T3 token
(`t3-fleet t3 connect`).

## services

```toml
services = ["web"]
```

Docker Compose stacks, reported only: running or not, and whether the compose
file each runs from matches the repo's `services/<name>/`. T3 Fleet never
deploys.

## Plugins

```toml
# t3-fleet.toml
[plugins]
areas = ["plugins/brew.mjs"]
```

A plugin exports `(kit) => area`; see `examples/plugins/brew.mjs`. A plugin
that fails to load, or an area whose observation or diagnosis fails, is
reported as a finding (`plugin-failed-<path>`, `<area>-unreadable`); every
other area is still checked.
