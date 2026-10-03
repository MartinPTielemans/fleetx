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
retries connection errors and 408, 429, 500, 502, 503, 504 and 529 up to
three times, only before the first byte reaches the client; sends SSE
keepalives while an event stream is quiet; and keeps per-upstream stats for
5 minutes, 1 hour and 24 hours (`fleetx models stats`, and the UI). It logs
metadata only, to `~/.local/state/fleetx/models.jsonl`; never bodies or auth
headers.

The area installs `fleetx models serve` as a service, writes a launcher per
enabled T3 provider instance it can route (`~/.local/bin/fleetx-claude`,
`fleetx-codex`, `fleetx-<instance>`), and points T3's instances at them
(`fleetx models route <instance>`; `--undo` reverts). A launcher follows its
instance's recipe: the variables (`env`) and leading arguments (`args`) that
point the CLI at `{proxy}`, the CLI to run (`command`), and a long-lived
credential to load from the node's secrets (`token_env`). Two recipes are
built in:

| driver | points it at the proxy | token_env |
|---|---|---|
| claudeAgent | `ANTHROPIC_BASE_URL={proxy}` | `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`; does not rotate) |
| codex | `-c openai_base_url="{proxy}"` (keeps Codex's built-in provider and login) | none |

Any other driver whose CLI takes a base URL is routed by declaring its recipe;
one that runs inside T3 without a CLI, or has no recipe, is a note. When the
proxy is not listening a launcher runs the CLI directly and notes it in
`~/.local/state/fleetx/models-fallback.log`.

With `egress = "relay"` the proxy sends traffic through the relay's `/egress`
route instead of directly, for a node on a bad network.

Independently of `[models]`, every node reports each T3 provider's login and
health as T3 itself sees it (`provider-logged-out-<instance>`,
`provider-unhealthy-<instance>`), read with fleetx's read-only T3 token
(`fleetx t3 connect`).

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
