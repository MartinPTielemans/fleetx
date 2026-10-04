# T3 Fleet

Every machine you run [T3 Code](https://github.com/pingdotgg/t3code) on, checked
in one command, and kept equivalent.

```
$ t3-fleet status
T3 Fleet  3 environments  2 warnings  (3.2s)

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

Nothing needs to be installed on the other machines: T3 Fleet streams itself over
ssh into `node -` (Node 24 or newer) and reads what it needs. It only reads;
changes happen through `t3-fleet fix`, after you have seen them.

## Getting started

```sh
curl -fsSL https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh | sh
t3-fleet setup                                  # the first machine starts a fleet
t3-fleet invite desktop                         # prints the line to run on desktop:
#   … | sh -s -- setup <your repo> desktop      # it joins, with what it already has
```

`setup` looks at the skills, MCP servers and instruction files a machine already
has, and shows one screen of what it would do before writing anything:
what goes into the repository, what gets linked, each conflict with the
fleet (with a diff and a choice), and every credential it found, which goes
into the encrypted secrets file and never into a plain file. `--plan` only
shows, `--yes` takes the defaults, `--resume` continues a setup that stopped.
Run it again on a machine any time to see what still differs. See the
[quickstart](docs/quickstart.md).

## Your setup lives in your own repository

T3 Fleet is the engine and knows nothing about your machines. Your setup lives in
a private repository of your own:

```
my-fleet/
├─ t3-fleet.toml          settings for the whole fleet
└─ nodes/
   ├─ laptop.toml       one file per machine
   ├─ server.toml       ssh = "server.tailnet.ts.net"
   └─ desktop.toml
```

Each machine has one local file, `~/.config/t3-fleet/config.toml`, saying where
that repository is and which node the machine is:

```toml
repo = "~/my-fleet"
node = "laptop"
```

A node file only needs `ssh` when its ssh destination differs from its name.

## Fixing

```
$ t3-fleet fix
t3-fleet fix  1 fix on 1 machine

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

If your providers go through a model proxy, describe it in `t3-fleet.toml`:

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

T3 Fleet then checks each machine's key against the proxy (a `/models` request,
no model call), reports machines whose providers skip the launcher, and offers
`enable` only once the key is accepted.

## Intended differences

When a difference is deliberate, accept it in `t3-fleet.toml` with the id that
`status --json` or `fleet_status` shows:

```toml
[[accept]]
id = "desktop:claude-other-copies"
reason = "the distribution ships its own package"
```

An accepted finding stays visible as a note with its reason, so it never
disappears without anyone remembering why.

## Only what changed

`t3-fleet status --changes` compares with the previous `--changes` run and prints
only findings that appeared, got worse, or were resolved, or one line saying
nothing changed. Scheduled checks use this to stay quiet.

## From a T3 thread

`t3-fleet mcp` serves two tools over stdio:

- `fleet_status`: the same report, as text to show plus findings with ids such
  as `server:t3-behind`. With `changesOnly` it also says what changed since the
  last such call.
- `fleet_apply_fixes`: runs fixes by id, only ones T3 Fleet proposed, after
  checking again that each still applies.

`t3-fleet setup` declares it as the MCP server `t3-fleet` in every machine's
Claude Code and Codex, so any thread can be asked "what's wrong with my
environments?".

## In the browser

```
$ t3-fleet ui
t3-fleet ui on http://127.0.0.1:53117/#ticket=…
```

A local web app in T3 Code's look, light and dark, with everything above:
the environments table (each machine opens to its providers, agent CLIs, sync
and model proxy), findings with their fixes, staged proposals with diffs,
alerts, skills on every machine (add, update and remove them), the MCP
hub's servers and tool-call log, model traffic, and every
machine's merged config. Applying a fix works as `t3-fleet fix` does: the exact
commands, what each interrupts, an explicit confirmation, then a fresh check.
What runs is what you reviewed: a fix whose command changed since is left out
and reported, and a proposal is approved only if it still makes the change you
saw. Fixes and repo changes keep running if you close or reload the tab; any
tab shows how they went, and Ctrl-C waits for them (a second Ctrl-C stops
them). It checks every minute while a tab is open and visible, and updates as
the relay reports syncs.

It listens on 127.0.0.1 only, on a new port each run, and answers only the tab
that opened its link, from its own address, so no other website can read your
fleet or apply fixes. The link works once: if it was already used, the page
says so (someone else on the machine may have opened it), and `t3-fleet ui`
prints a new one for each further tab. `--port` pins the port, `--no-open`
prints the link instead of opening a browser. The app is built into the single
`t3-fleet` file. It reads the config again for every check, fix and action;
when T3 Fleet is upgraded on this machine while it runs (as `t3-fleet mcp`
does too), it stops installing its build on other machines until you restart
it, since that would put the old build back.

## Documentation

- [Quickstart](docs/quickstart.md): `t3-fleet setup`, from one machine to two
- [Topologies](docs/topologies.md): roles, relays, profiles
- [Areas](docs/areas.md): everything T3 Fleet manages, and its settings
- [Troubleshooting](docs/troubleshooting.md): every `doctor` finding explained
- [Plan](docs/PLAN.md): what is built and what is next

## Development

T3 Fleet uses T3 Code's own stack (TypeScript, Effect 4, Node 24, pnpm,
vite-plus), so its packages could move into T3's monorepo.

```sh
pnpm install
pnpm typecheck && pnpm test
pnpm --filter t3-fleet build     # builds apps/ui into the bundle too
node apps/cli/dist/bin.mjs status
T3_FLEET_UI_FIXTURES=1 pnpm --filter @t3-fleet/ui dev   # the UI against a made-up fleet
tests/integration/run.sh       # three throwaway nodes in Docker
```

## License

MIT
