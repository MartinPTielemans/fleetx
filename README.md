# fleetx

Every machine you run [T3 Code](https://github.com/pingdotgg/t3code) on, checked
in one command, and kept equivalent.

```
$ fleetx status
fleetx  3 environments  2 warnings  (3.2s)

           T3                          CLAUDE     CODEX      PROVIDERS IN T3    SYNC
  laptop   ✓ 0.0.46 nightly 10-03      ✓ 2.1.288  ✓ 0.160.0  ✓ claude  ✓ codex  ✓ 2m ago
  server   ! 0.0.43 nightly 09-27 -23  ✓ 2.1.288  ✓ 0.160.0  ✓ claude  ✓ codex  ✓ 7m ago
  desktop  ✓ 0.0.46 nightly 10-03      ✓ 2.1.288  ! 0.160.0  ✓ claude  ! codex  ✓ 4m ago

  ! server   T3 is 23 nightly releases behind (0.0.43 nightly 09-27 → 0.0.46 nightly 10-03)
             fix ~/.t3/runtime/versions/0.0.43-nightly.20260927.2344/t3 update --channel nightly --yes
  ! desktop  T3 runs codex from ~/.local/share/mise/shims/codex, not the managed codex
             upgrades of ~/.local/bin/codex never reach T3 here
```

For each machine it checks:

- **T3**: the running server's version against the newest release on its channel.
- **Providers in T3**: each enabled provider, launched exactly the way the T3
  server would, with the server's own environment. A provider that works in
  your terminal can still fail inside T3; this is where you find out.
- **Agent CLIs**: Claude Code and Codex against the latest releases, and which
  copy your shell and T3 actually run.
- **A model proxy**, if you route providers through one: whether each machine's
  key is accepted, before any provider is pointed at it.
- **Across machines**: a provider on everywhere but one, or routed differently.

Nothing needs to be installed on the other machines: fleetx streams itself over
ssh into `node -` (Node 24 or newer) and reads what it needs. It only reads;
changes happen through `fleetx fix`, after you have seen them.

## Your setup lives in your own repository

fleetx is the engine and knows nothing about your machines. Your setup lives in
a private repository of your own:

```
my-fleet/
├─ fleetx.toml          settings for the whole fleet
└─ nodes/
   ├─ laptop.toml       one file per machine
   ├─ server.toml       ssh = "server.tailnet.ts.net"
   └─ desktop.toml
```

Each machine has one local file, `~/.config/fleetx/config.toml`, saying where
that repository is and which node the machine is:

```toml
repo = "~/my-fleet"
node = "laptop"
```

A node file only needs `ssh` when its ssh destination differs from its name.

## Fixing

```
$ fleetx fix
fleetx fix  1 fix on 1 machine

  server    T3 is 23 nightly releases behind (0.0.43 nightly 09-27 → 0.0.46 nightly 10-03)
            $ ~/.t3/runtime/versions/0.0.43-nightly.20260927.2344/t3 update --channel nightly --yes
            interrupts: restarts the T3 server on server; threads running there stop
Apply 1 fix? (y/N)
```

`fix` shows every command before it runs, marks the ones that interrupt
something, asks, runs them in parallel across machines, and checks again
afterwards. `--safe` keeps only fixes that interrupt nothing, `--dry-run` stops
after the plan, `--node server` narrows to one machine. Findings that need a
decision rather than a command are listed, never guessed at.

## Routing providers through a proxy

If your providers go through a model proxy, describe it in `fleetx.toml`:

```toml
[proxy]
# {"endpoint": "https://proxy.example/v1", "api_key": "..."}, one per machine
credentials = "~/.config/my-proxy.json"
# Points T3's provider at its launcher; {provider} is the instance id.
enable = "my-proxy-enable --provider {provider}"
rejected_hint = "restart the proxy so it loads new keys"

[proxy.launchers]
claudeAgent = "~/.local/bin/proxy-claude"
codex = "~/.local/bin/proxy-codex"
```

fleetx then checks each machine's key against the proxy (a `/models` request,
no model call), reports machines whose providers skip the launcher, and offers
`enable` only once the key is accepted.

## Intended differences

When a difference is deliberate, accept it in `fleetx.toml` with the id that
`status --json` or `fleet_status` shows:

```toml
[[accept]]
id = "desktop:claude-other-copies"
reason = "the distribution ships its own package"
```

An accepted finding stays visible as a note with its reason, so it never
disappears without anyone remembering why.

## Only what changed

`fleetx status --changes` compares with the previous `--changes` run and prints
only findings that appeared, got worse, or were resolved, or one line saying
nothing changed. Scheduled checks use this to stay quiet.

## From a T3 thread

`fleetx mcp` serves two tools over stdio:

- `fleet_status`: the same report, as text to show plus findings with ids such
  as `server:t3-behind`. With `changesOnly` it also says what changed since the
  last such call.
- `fleet_apply_fixes`: runs fixes by id, only ones fleetx proposed, after
  checking again that each still applies.

Register it with Claude Code (`claude mcp add fleetx -- fleetx mcp`) or Codex,
and any thread can be asked "what's wrong with my environments?".

## Documentation

- [Quickstart](docs/quickstart.md): one machine to two in five minutes
- [Topologies](docs/topologies.md): roles, relays, profiles
- [Areas](docs/areas.md): everything fleetx manages, and its settings
- [Troubleshooting](docs/troubleshooting.md): every `doctor` finding explained
- [Plan](docs/PLAN.md): what is built and what is next

## Development

fleetx uses T3 Code's own stack (TypeScript, Effect 4, Node 24, pnpm,
vite-plus), so its packages could move into T3's monorepo.

```sh
pnpm install
pnpm typecheck && pnpm test
pnpm --filter fleetx build
node apps/cli/dist/bin.mjs status
tests/integration/run.sh       # three throwaway nodes in Docker
```

## License

MIT
