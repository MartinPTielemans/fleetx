# T3 Fleet

**Every machine you run [T3 Code](https://github.com/pingdotgg/t3code) on, kept
equivalent.** Your laptop, your desktop, the server in the closet: same T3
version, same providers working, same skills, same MCP servers, signed in once.

T3 Fleet shows every machine in one place, explains what differs and why, and
fixes it after you've seen exactly what will run.

## Pick your setup

Start on the computer you use every day. That machine stays in charge: it's
where you approve changes and where your secrets are decrypted. What you add
around it depends on what you have.

### Just this computer

You run T3 on one machine. T3 Fleet keeps T3 and your agent CLIs current,
catches providers that work in your terminal but fail inside T3, and backs up
your skills, MCP servers and instructions to a private repository. When a
second machine shows up, it joins with what it already has.

### This computer and an always-on server (recommended)

Do you have something that stays on: a home server, a Mac mini, a VPS? Make it
your **hub**. It works for the fleet; it doesn't control it:

- **Changes arrive right away.** Every machine hears the moment you change
  something, and a laptop that slept catches up when it wakes.
- **Your MCP servers in one place, if you want.** A switch in setup, off by
  default: the hub hosts your MCP servers, so you sign in to each once, on
  the hub, every machine uses that login, and containers run only there.
  Until you sign in there, those servers stop working on your machines.

Your own computer stays the **authority**: it approves changes and holds the
keys. The hub runs things; you decide things. A laptop shouldn't be the hub,
because it sleeps.

### Several machines

Add as many as you like. Each joins with the skills and servers it already has,
and you settle any conflicts with the fleet one at a time, with a diff, before
anything is written. Want to stop? `t3-fleet leave` gives a machine back
everything it had before it joined.

More on roles and layouts: [topologies](docs/topologies.md).

## Getting started

```sh
curl -fsSL https://github.com/MartinPTielemans/fleetx/releases/latest/download/install.sh | sh
```

When it finishes, on a first install on your own computer (a Mac, or Linux
with a desktop), a setup wizard opens in your browser. Elsewhere, such as a
server over ssh, the installer prints the command to run next, and `t3-fleet ui`
opens the wizard on any computer with a browser.
It asks what machines you have, recommends a layout, and asks where your setup
should live: a new private GitHub repository, one you already have, or just
this computer. If you have an always-on machine, it checks it over ssh from
here and sets it up as your hub. Before anything is written you see the whole
plan: what goes into your repository, each conflict with a choice, and every
credential it found. Credentials go into an encrypted file, never a plain one.

Setup also asks how the fleet looks after your machines. **Keep things up to
date automatically** is on: T3 Code (when no thread is running), Claude Code
and Codex, and skills are updated by each sync, with no agent involved. Turn it
off and they wait for you to apply them. Alerts show as a notification on your
computer, and can go to your phone through [ntfy](https://ntfy.sh) on a
private topic setup makes for you.

Close the tab and want it back? `t3-fleet ui`. When it's done, the wizard gives
you the line to run on each next machine.

### Prefer the terminal?

The wizard and the CLI run the same setup, so you get the same plan either way.

```sh
t3-fleet setup        # on your own computer: starts the fleet
t3-fleet invite hub   # prints the line to run on the next machine
```

Or `brew install martinptielemans/tap/t3-fleet`. The
[quickstart](docs/quickstart.md) walks through both paths, from one machine to
two.

## See your fleet

```sh
t3-fleet ui
```

This opens a local web app that looks like T3 Code, in light and dark:

- **Environments**: every machine, with its T3 version, providers, agent
  CLIs, sync and model proxy.
- **Findings and fixes**: what differs and why. Each fix shows its exact
  commands and what it would interrupt (an update restarts T3 and stops the
  threads running there). Nothing runs until you confirm.
- **Proposals**: changes from other machines, with diffs, waiting for you.
- **Skills and MCP**: what's on every machine. Add, update and remove skills,
  and see the hub's servers and their tool calls.
- **Models**: traffic through your model proxy, if you use one.

With a hub, the hub hosts the app on your tailnet, so you open it from any
device signed in to Tailscale as a login the fleet allows. The wizard allows
yours when it brings up the hub; with a hub set up in the terminal
(`t3-fleet setup … --relay` on it), the authority that approves it allows its
own Tailscale login, or says what to add to `[ui] allow` when it has none
([cli](docs/cli.md#on-the-hub)).
It shows each machine as it last reported, sends a fix to the machine it
changes (which checks itself again and runs only what it proposes), and leaves
approving proposals to an authority. Without a hub, or with
`t3-fleet ui --local`, it runs only on your computer (127.0.0.1) and answers
only the tab it opened.

## Ask from a T3 thread

Setup adds T3 Fleet as an MCP server in Claude Code and Codex on every
machine. You can ask any thread "what's wrong with my environments?" and it
answers with the same findings, and can apply the same fixes after checking
again that each still applies.

## Prefer the terminal?

Everything the app does, the CLI does too:

```
$ t3-fleet status
T3 Fleet  3 environments  1 warning  (3.2s)

           T3                          CLAUDE     CODEX      PROVIDERS IN T3    SYNC
  laptop   ✓ 0.0.46 nightly 10-03      ✓ 2.1.288  ✓ 0.160.0  ✓ claude  ✓ codex  ✓ 2m ago
  hub      ! 0.0.43 nightly 09-27 -23  ✓ 2.1.288  ✓ 0.160.0  ✓ claude  ✓ codex  ✓ 7m ago

  ! hub      T3 is 23 nightly releases behind (0.0.43 nightly 09-27 → 0.0.46 nightly 10-03)
```

`t3-fleet fix` applies fixes the same way the app does. See [the CLI](docs/cli.md)
for every command, model proxies, accepting deliberate differences, and
optional checks from a thread.

## How it works

Alerts arrive as notifications; no agent needed.

- **Your setup lives in your own private repository**: one settings file
  for the fleet and one file per machine. T3 Fleet itself knows nothing about
  your machines.
- **Nothing to install elsewhere just to check.** T3 Fleet runs itself over ssh
  on the other machines (Node 24 or newer) and reads what it needs.
- **Checks only read.** Anything that changes a machine is a fix, and you see
  it before it runs.
- **Git is always the source of truth.** The hub only makes things faster,
  so if it's down, every machine still syncs from the repository.

## Documentation

- [Quickstart](docs/quickstart.md): setup, from one machine to two, and back with `leave`
- [Topologies](docs/topologies.md): roles, the hub, profiles
- [The CLI](docs/cli.md): every command and setting
- [Areas](docs/areas.md): everything T3 Fleet manages
- [Troubleshooting](docs/troubleshooting.md): every finding explained
- [Plan](docs/PLAN.md): what's built and what's next

## Development

T3 Fleet uses T3 Code's own stack (TypeScript, Effect 4, Node 24, pnpm,
vite-plus), so its packages could move into T3's monorepo.

```sh
pnpm install
pnpm typecheck && pnpm test
pnpm --filter t3-fleet build                            # builds the UI into the bundle too
node apps/cli/dist/bin.mjs status
T3_FLEET_UI_FIXTURES=1 pnpm --filter @t3-fleet/ui dev   # the UI against a made-up fleet
tests/integration/run.sh                                # three throwaway nodes in Docker
tests/integration/wizard-e2e.sh                         # the wizard end to end: a hub, an invite, alerts
```

## License

MIT
