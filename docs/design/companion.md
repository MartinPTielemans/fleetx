# Design: T3 Fleet as T3 Code's companion

T3 Fleet grows from "keeps machines equivalent" into the companion for every
machine someone runs T3 Code on. Three new parts join the engine:

1. **models**: a model proxy on every node, between T3's providers and
   Anthropic and OpenAI. It makes provider traffic stable and visible, and it
   detects and prevents Claude logouts.
2. **hub**: T3 Fleet's own MCP hub on the relay node, replacing ToolHive. It runs
   hosted servers, holds their OAuth logins, serves every client through one
   gateway, and logs tool calls.
3. **ui**: `t3-fleet ui`, a local web app in T3 Code's look, showing everything
   T3 Fleet knows and doing everything the CLI does.

The existing principles still hold (docs/PLAN.md): observe, plan, apply;
probes are read-only; every change is a fix shown before it runs; git is
enough and the relay only adds speed; failures are visible; nothing personal
in the engine.

Shared contracts live in `packages/core/src/Api.ts`. Each part implements or
consumes those schemas; nobody invents a second shape for the same data.

## Ports

| Port | Where | What |
|---|---|---|
| 8399 | relay node, 127.0.0.1, published to the tailnet | relay: sync events, state, MCP gateway, hub management, OAuth callback |
| 8398 | every node, 127.0.0.1 only | model proxy |
| random (or `--port`) | the machine running `t3-fleet ui`, 127.0.0.1 only | UI and its `/api` |
| 18200–18299 | relay node, 127.0.0.1 only | hub-run MCP servers (allocated by the hub) |

## 1. models: the model proxy

### Why

Claude logins drop every few days on some machine. Claude Code and Codex use
rotating OAuth refresh tokens, and T3 runs many CLI processes per machine that
share one credentials file; concurrent refreshes invalidate each other. The
fix for Claude is a credential with no refresh: `claude setup-token` (an
Anthropic-supported long-lived subscription token, read from
`CLAUDE_CODE_OAUTH_TOKEN`). The proxy adds what the CLIs cannot do alone:
retries before the first byte, keepalives, visibility per machine, and one
place to route traffic.

### Boundary

The proxy is a pass-through. The official CLI makes every request with its
own credential; the proxy forwards it unchanged. It never holds a provider
login, never logs in on anyone's behalf, never pools credentials, and never
rewrites what the client says it is (no user-agent or version cloaking).
Request and response bodies and auth headers are never logged.

A user can still run an external proxy such as CLIProxyAPI through the
existing `[proxy]` settings; that path stays as it is.

### Shape

- `t3-fleet models serve`: long-running, on 127.0.0.1:8398, installed as a
  service by the `models` area (launchd / systemd, like the relay listener).
- Routes: `/<upstream>/*` forwards to that upstream: `anthropic`
  (`https://api.anthropic.com`), `openai` (the ChatGPT backend for a ChatGPT
  login, `https://api.openai.com/v1` for an API key), and any upstream the
  settings declare. `GET /stats` returns `ModelProxyStats`; `GET /health`.
- Retries: on network errors from before the request left (refused,
  unresolvable, connect timeout, TLS handshake), and on 408, 429, 500, 502,
  503, 504, 529, up to 3 retries with jittered backoff, only before the first
  response byte. `x-should-retry` is obeyed and `retry-after-ms` /
  `retry-after` honoured, within 10s of waiting in all; then the CLI's own
  retries take over. A request the upstream may have received is never sent
  twice. Header and body timeouts are the proxy's (10 minutes), not Node's
  fetch defaults. After streaming starts an error passes through as a dropped
  connection. SSE keepalive comments every 15s while waiting upstream.
- Restarts: the proxy counts requests in flight. A new build is not
  restarted by the install: the proxy notices it, keeps serving until idle
  (15 minutes at most) and exits; SIGTERM drains the same way for 45s. The
  unit restarts it after a second.
- Optional `egress = "relay"`: forward through the relay
  (`/egress/<upstream>/*`, relay token) instead of directly,
  for a node on a bad network. The relay forwards only to declared upstream
  bases; when it cannot be reached or refuses, the request goes direct.
- Launchers: the area writes one small shell script per routed T3 provider
  instance (`~/.local/bin/t3-fleet-claude`, `t3-fleet-codex`,
  `t3-fleet-<instance>`). Each follows its instance's recipe: the variables or
  leading arguments that point the CLI at the proxy (`ANTHROPIC_BASE_URL` for
  Claude, `-c openai_base_url=…` for Codex, declared ones for other drivers),
  and a long-lived credential loaded from `~/.config/t3-fleet/secrets.env`
  (`CLAUDE_CODE_OAUTH_TOKEN` for Claude). It falls back to running the CLI
  directly when the proxy is not listening (logged to
  `~/.local/state/t3-fleet/models-fallback.log`, which the area reports).
- Provider logins: every node reports each T3 provider instance's login and
  health from T3 itself (`server.getConfig`, read with T3 Fleet's own
  `orchestration:read` token, `t3-fleet t3 connect`), for every driver T3 has.
  Without the token, Claude and Codex are checked through their CLIs.
- Stats: rolling windows (5 minutes, 1 hour, 24 hours) per upstream:
  requests, retried, failed by class, fallbacks, time to first byte p50/p95,
  last error. Metadata only, to `~/.local/state/t3-fleet/models.jsonl`, bounded.

### Settings

```toml
[defaults.models]
egress = "direct"                      # or "relay"

[defaults.models.upstreams.<name>]     # beyond the built-in anthropic and openai
url = "https://…"

[defaults.models.providers.<instanceId>]
upstream = "<name>"                    # built in for claudeAgent and codex
env = { SOME_BASE_URL = "{proxy}" }    # or args = [...]; built in for claudeAgent and codex
token_env = "…"                        # long-lived credential; CLAUDE_CODE_OAUTH_TOKEN for Claude
route = false                          # leave an instance alone
```

### Findings

- `provider-logged-out-<instance>` (error): T3 reports the instance as not
  logged in (or, without T3's snapshot, `claude auth status` / `codex login
  status` say so). Every node, with or without `[models]`.
- `provider-unhealthy-<instance>` (warn): T3 reports the instance as warning
  or error; the detail is T3's message.
- `t3-access` (warn, fix): T3 Fleet has no working read-only T3 token; the fix
  is `t3-fleet t3 connect`.
- `provider-token-missing-<instance>` (warn): `[models]` routes the instance,
  its recipe names a long-lived credential, and the secret is not set.
- `models-service` (warn, fix): the proxy service is missing, stale or down.
- `models-launcher-<instance>` (warn, fix): a launcher is missing or out of
  date.
- `models-not-routed-<instance>` (warn, fix): T3 does not launch the instance
  through its launcher. The fix points T3's provider instance at it (T3 has no
  interface for this; it edits only that binaryPath in settings.json, which T3
  reloads).
- `models-unroutable-<instance>` (info): no CLI or no recipe to route it.
- `models-failing` (warn): more than 5% of requests failed in the last hour,
  or fallbacks happened; the detail names the error class.

## 2. hub: T3 Fleet's MCP hub

### Shape

The hub runs inside `t3-fleet relay serve` on the relay node. Every definition
in the repo's `mcp/` with a hosted kind is served; there is nothing else to
list. Clients reach every hosted server at `<relay url>/mcp/<name>`.

| kind | the hub |
|---|---|
| `remote` | proxies to `url`, adding the server's credential (OAuth or a bearer secret) |
| `container`, `registry` | runs `image` with Docker on a port it allocates, then proxies to it; `transport = "stdio"` images are bridged (below) |
| `hosted-stdio` | runs `command` on the relay node and bridges it |
| `stdio`, `direct` | not hosted; registered in clients as today |

Containers run `--cap-drop ALL --security-opt no-new-privileges`, bound to
127.0.0.1, with `env` from the fleet's secrets and an optional
`network = "none"`. The hub names them `t3-fleet-mcp-<name>`, adopts a matching
running container after a restart instead of starting a second, and restarts
a server that dies, with backoff.

A **stdio bridge** turns one stdio process into a streamable HTTP endpoint for
many clients: it caches the server's `initialize` result, gives each client
its own `Mcp-Session-Id`, rewrites JSON-RPC ids so responses reach the right
client, and fans out notifications. Clients rarely close their sessions (the
MCP TypeScript SDK's `close()` does not), so at 1000 sessions the least
recently used one with no request in flight makes room for a new one instead
of the new one being refused. A session with no open GET stream and nothing
in flight also expires after a day unused: long enough that a client which
only POSTs (Claude Code stops re-opening its stream after a few tries) keeps
its session across a sleep. The fleet's own live check deletes the session its
`initialize` opened. A request whose client goes away, or that hears nothing
for 10 minutes (progress counts), gets an error and the server gets
`notifications/cancelled` (never for `initialize`). Stopping a bridge fails
its outstanding requests and ends every session's stream.

The gateway records which client opened each session and refuses a session
it has no record of. A bridged session's record ends when the bridge ends the
session; a proxied server's ends on DELETE, an upstream 404, or a day unused,
and is kept in `~/.local/state/t3-fleet/hub/sessions.json` (server, client and
a SHA-256 of the session id) so it survives a relay restart.

Starting, stopping, restarting and reloading servers take turns under one
lock, so the minute's reload cannot start a second copy of a server that is
being restarted. A failed `docker run` removes the container only when it
carries that run's own label.

### OAuth

The hub is an OAuth client per the MCP authorization spec (2025-06-18):

1. A 401 with `WWW-Authenticate: ... resource_metadata=...` (or the
   definition's `remote_auth = true`) means the server needs a login.
2. Discovery: protected resource metadata (RFC 9728), then the authorization
   server's metadata (RFC 8414, falling back to OpenID discovery).
3. Client: dynamic registration (RFC 7591) when offered, else
   `oauth = { client_id = "...", client_secret_env = "..." }` from the
   definition.
4. Authorization code with PKCE S256, `resource` (RFC 8707), the definition's
   `remote_auth_scopes`, and `redirect_uri = <relay url>/oauth/callback`, so
   signing in works from any browser on the tailnet with no tunnel.
5. Tokens are stored encrypted to the relay node's own age key, in
   `~/.local/state/t3-fleet/hub/tokens.age`, with the resource they were
   issued for; they are sent only to that URL. Refresh is done ahead of expiry,
   and a 401 triggers one. One refresh runs per server at a time, in the hub's
   own scope, and requests wait for it, so a client hanging up cannot lose a
   rotated refresh token. When the authorization server refuses the refresh
   (`invalid_grant`) the server goes to `needs-login` and an alert is raised;
   `invalid_client` or `unauthorized_client` from the token endpoint also
   drops the dynamic client registration (a refused authorization callback
   changes nothing). Other failures (5xx, 429, timeouts) keep the login: the
   still-valid access token is used, and the refresh is retried with a
   backoff. Once the access token has expired, three 4xx answers other than
   429 without a code the hub acts on count as a refusal too.

A login starts with `POST /hub/servers/<name>/login`, which returns the URL to
open; `t3-fleet mcp login <name>` and the UI both use it. `GET
/hub/logins/<state>` says how the login with that URL's `state` went.

### Clients and policy

The gateway accepts the relay token (as today) and per-client tokens created
with `t3-fleet mcp token create <client>` (stored hashed on the relay node; the
plaintext is shown once and kept in the fleet's secrets). A definition may
deny tools (`tools = { deny = ["delete_*"] }`); a client token may be limited
to some servers. Denied calls get a JSON-RPC error and are logged.

### Log and health

Every JSON-RPC request through the gateway is recorded as a `HubCall`
(server, client, method, tool name, duration, outcome; never arguments or
results), in a ring buffer and `~/.local/state/t3-fleet/hub/calls.jsonl`.
Servers receive each message rebuilt from its JSON-RPC fields, never the raw
body. The hub runs an `initialize` and `tools/list` against each server every
minute; `HubServer.state` is `starting`, `running`, `needs-login`, `error` or
`stopped`. Each server's check is isolated, so one server answering nonsense
cannot stop the loop, and a process or container that misses three checks in
a row is restarted, unless a client request is in flight: a server running a
long synchronous tool is busy, not hung. State changes are emitted on
`/events` as `hub` events.

### Relay endpoints added

All need the relay token; `/oauth/callback` is public (it checks `state`).

```
GET    /hub/servers                    HubServer[]
POST   /hub/servers/<name>/login       { url }
GET    /hub/logins/<state>             { status, server, detail }
POST   /hub/servers/<name>/logout      204
POST   /hub/servers/<name>/restart     204
GET    /hub/calls?server=&limit=       HubCall[]
GET    /oauth/callback                 finishes a login, shows a small page
*      /mcp/<name>                     the gateway
```

### Migration from ToolHive

The `mcp` area reports a node still running ToolHive workloads for servers the
hub serves (`mcp-toolhive-left`), with a fix that stops them (marked as
disrupting those servers until the hub is signed in). `[mcp] ports` is no
longer needed when the hub is on; hosted servers resolve to the gateway.
`needs-login` becomes the finding `mcp-<name>-needs-login` with the sign-in
command; there is no automatic fix, because a person signs in.

## 3. ui: `t3-fleet ui`

A local web app, `apps/ui` (React, Vite, Tailwind), in T3 Code's visual
language: its colours, type, density, dark and light modes. `t3-fleet ui` serves
the built app and `/api` on 127.0.0.1, on a random port unless `--port` names
one, and opens the browser with a one-use link. It runs
where the user is (usually the authority), so it can ssh to nodes for checks
and fixes, and it reads the relay for live state and the hub.

The built app is embedded in the `t3-fleet` bundle, so the single-file release
still works.

### Views

- **Environments**: the status table, live; each machine opens to its
  providers, agent CLIs, sync, model proxy and areas.
- **Findings**: grouped by machine and area; apply fixes with the same plan,
  disruption marks and confirmation as `t3-fleet fix`; notes with a fix can be
  picked too; accepted notes shown with their reasons.
- **Proposals**: review, approve and reject staged changes, with diffs; a
  decision names the change that was shown, so a sync that re-creates the
  same commit does not void it, and a different one is not decided unseen.
- **Alerts**: the alert history.
- **Skills**: the repo's skills against every machine, each link's state;
  add from a git repository (looked up first, then chosen), update (a diff
  first, kept only if upstream still gives the same change), remove; link,
  clean-up and adopt fixes through the Findings dialog. Repo edits hold
  sync's lock and land as `t3-fleet skills` does: committed on an authority,
  proposed elsewhere.
- **MCP**: every server with its state; sign in, sign out, restart; the
  tool-call log, filterable.
- **Models**: per machine and upstream, traffic health from `ModelProxyStats`,
  and Claude's login state.
- **Config**: a machine's merged settings with where each value comes from.

### API

Defined in `Api.ts` (`Ui*` schemas). The link's ticket is traded once for a
tab token (`POST /api/session`); every other `/api` request carries the token
as a header, and only `GET /api/events` may take it in the query.

Updates arrive on `GET /api/events` (server-sent events): first where things
stand (the latest `check`, a newer `check-failed`, every `job`), then relay
events passed through, `check` when a check finishes, `check-failed` when one
does not, and `job` as jobs move. Checks run one at a time and are shared by
everyone who asks meanwhile; one runs on start and every 60 seconds while a
tab is open and visible, and never while fixes run.

Fixes are planned (`POST /api/fixes/plan`: each fix's command, node, `on`,
interruption and a digest), shown, and applied by digest: the server checks
again and runs only fixes whose digest still matches, and fixes that
interrupt something only if acknowledged. Applying fixes, approving or
rejecting a proposal (by its change: each file's blob on the branch and in
the proposal), and adding, updating or removing skills
are jobs: they run in the server, survive the tab, are listed at `GET /api/jobs` for half an hour after they
finish, and stopping `t3-fleet ui` waits for them (a second Ctrl-C does not).

## Who builds what

| Part | Owns |
|---|---|
| models | `packages/core/src/models/`, `areas/Models.ts`, Claude auth in Probe/Observation/Diagnose, `apps/cli/src/models.ts`, relay `/egress` |
| hub | `packages/core/src/hub/`, `Relay.ts` changes, `areas/Mcp.ts` changes, `apps/cli/src/hub.ts` (`t3-fleet mcp login`, `token`) |
| ui | `apps/ui/`, `packages/core/src/UiServer.ts`, `apps/cli/src/ui.ts`, build embedding |

Shared files (`Areas.ts`, `bin.ts`, `Api.ts`, `PROBE_PROTOCOL`) take small
additive edits; conflicts there are resolved at integration.
