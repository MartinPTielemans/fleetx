# Design: the browser setup wizard

Setting up T3 Fleet is a handful of decisions: what machines you have, which
one is always on, where the setup lives, what to do with each difference. The
wizard asks them in a browser, on your own computer, and sets up the always-on
machine for you over ssh.

## Goals

- **Visual first.** `curl … | sh` installs, the browser opens (on a first
  install on a desktop), and each screen asks one thing. You see the layout before you pick it and the plan before
  anything is written.
- **The CLI is not left behind.** `t3-fleet setup` stays, with every flag it
  has. It is an equal way in, not a fallback.
- **One engine.** The wizard and `t3-fleet setup` run the same planning and
  apply code (`setup/Plan.ts`, `setup/Apply.ts`). The wizard moves the
  questions from terminal prompts to screens; it does not decide anything
  differently. The same plan comes out of both.
- **Same rules as the rest of T3 Fleet.** Probes only read. Anything that
  changes a machine is shown before it runs.

## Starting it

`t3-fleet ui` (or `t3-fleet setup --ui`) on a machine that is not in a fleet
opens the wizard instead of the fleet app. The state it reads says which of
three things it is:

| stage        | the app shows                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `fresh`      | the wizard, from the first screen                                                                                                       |
| `unfinished` | a setup stopped part-way: resume it, or abandon it                                                                                      |
| `member`     | the fleet app; the wizard is not needed. Once a hub hosts the app, `t3-fleet ui` opens the hub's address instead (`--local` stays here) |

At the end of a first install, run with no command, the installer runs
`t3-fleet ui`, which opens the browser, when there is a desktop to open it on:
a Mac, or Linux with `DISPLAY` or `WAYLAND_DISPLAY` set. Anywhere else (a
server over ssh, say), and on an update, it prints the next command instead.
`curl … | sh -s -- setup <url> <name>` runs that command, with the terminal as
its input so setup can ask its questions.

## Roles: authority and hub

The wizard keeps two roles apart because they ask different things of a
machine.

- The **authority** decides. It approves changes and decrypts the secrets.
  That belongs to the computer you sit at, so it is always the one the wizard
  runs on.
- The **hub** works for the fleet. It runs the relay and the MCP hub, so
  changes arrive at once, OAuth logins happen once, and containers run in one
  place. It needs to be always on and reachable from the other machines.

A machine can be both (a single VPS is), but the wizard does not suggest it:
the machine you sit at is usually not the machine that stays on, and a laptop
that sleeps is never the hub.

## The screens

Each screen decides one thing.

1. **What do you have?** Whether you have an always-on machine, and how many
   other machines you run T3 on. Nothing is checked or written yet.
2. **The recommended layout.** One of three, with the reason and what each
   machine does. You can change your answer and watch it change.
3. **Where the setup lives.** A new private GitHub repository (when `gh` is
   signed in), an existing repository URL (joining a fleet, or one made by
   hand), or local only, with a remote added later.
4. **The hub, checked.** Only when the layout has one. You give its ssh
   address and this computer checks it, read-only: that it is in no other
   fleet (nor part-way through another's setup), Node, git, T3, tailscale,
   docker, and a service manager. Each missing item says how to fix it.
   Tailscale and docker are recommended, not required. A machine in another
   fleet is refused here, and again before the bring-up writes anything.
5. **The plan.** What setup would add, what is already the same, each
   conflict with a diff and a default, what it leaves alone and why, every
   credential it found (by name, never the value), and every step in order,
   including what the hub will be asked to do. Credentials a server needs and
   did not find are asked for here.
6. **Apply.** A job with live progress. This computer first, then the hub.
7. **Invite.** The line another machine runs to join, per machine, and a test
   notification. Both stay in the fleet app afterwards, under Add machines,
   on an authority.

## Choices and defaults

Besides the layout and the repository, setup asks how the fleet looks after
the machines. Each is a switch in the wizard and a flag in the terminal, with
the same default in both (`UPKEEP_DEFAULTS` in `packages/core/src/Upkeep.ts`),
and the plan lists what each writes before anything is.

| choice                               | where                 | default | writes                                                                                             |
| ------------------------------------ | --------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| Keep things up to date automatically | first screen          | on      | `[fleet] apply` with or without `t3`, `agents`, `skills`; on, `[defaults.t3] update = "when-idle"` |
| Notify me on this computer           | first screen          | on      | this machine in `[notify] desktop`                                                                 |
| Push to my phone with ntfy           | first screen          | off     | `[notify] ntfy = "T3_FLEET_NTFY_URL"`, the topic URL stored as that secret                         |
| Host your MCP servers on the hub     | the hub, once checked | off     | `[defaults.mcp] hub = true`, `gateway` = the relay URL                                             |

- **Upkeep is deterministic.** Updates are sync applying safe fixes; no agent
  turn is needed to keep machines current. Off, sync still applies `engine`,
  `secrets`, `dotfiles`, `instructions`, `mcp` and `relay`, so the machines
  stay the fleet's (the relay's services are its plumbing, not software of the
  user's); updates and new skills wait for the user. Only a new fleet takes
  this choice: a fleet being joined keeps its own `[fleet] apply`.
- **Notifications need no agent either.** The ntfy topic is 128 random bits
  on ntfy.sh, made in the browser (or by the terminal), shown once with a copy
  button, and stored like any setup secret: encrypted before the first step,
  never in job events or the saved run. A fleet that pushes already keeps its
  topic. Once setup is done, the last screen offers "Send a test", which sends
  one through the paths just set up, as `t3-fleet notify test` does.
- **The MCP hub is opt-in** because it moves every OAuth login: until each is
  signed in on the hub, those servers stop working on every machine. It needs
  the hub's tailnet address; without tailscale there the switch is off and
  says why. The hub's plan steps say "relay and MCP hub" exactly when it is on,
  and the plan lists each server: the plain https ones move to the hub
  (`remote`); one that runs a command, sends its own headers, speaks SSE or
  has a secret in its URL stays on each machine, with that reason
  (`setup/HubHosting.ts`).

## The layout recommendation

The rules are in `packages/core/src/setup/Topology.ts`, as one pure function,
so the app and the server agree and every rule is tested.

| you have                     | layout    | what it means                                                    |
| ---------------------------- | --------- | ---------------------------------------------------------------- |
| an always-on machine         | `hub`     | this computer is the authority; the always-on machine is the hub |
| no always-on machine, others | `several` | every machine syncs from the repository; a hub can come later    |
| nothing else                 | `single`  | T3 and its providers kept healthy here, backed up to the repo    |

Other machines join with what they already have, whichever layout it is.

## What apply does

Apply runs the plan the user saw, as a server-side job. Closing the tab does
not stop it, and reopening the wizard shows where it is.

- The `setup` job does what `t3-fleet setup` does on this computer: creates or
  connects the repository, encrypts the secrets, commits and pushes, links
  skills and instructions, installs the timer, declares T3 Fleet's MCP server,
  and syncs once.
- The `setup-hub` job then brings the hub up over ssh from this computer
  (install T3 Fleet there, join the fleet, sync it so it runs the relay as a
  service, and host the MCP servers when that was chosen). It is done only
  once the relay answers on the hub (`t3-fleet relay health`); it says too
  whether the relay's tailnet address answers from this computer. Last, this
  computer syncs, so its listener runs now; the fleet's other machines start
  theirs on their next sync. A sync running here or on the hub when a step
  needs it is waited for, never taken for done. The steps are listed on the
  plan screen before anything runs, in the words the job reports them
  (`setup/PlanWords.ts`).

## The HTTP contract

`t3-fleet ui` serves a few endpoints under `/api/setup/`. The schemas and the
full description are in `packages/core/src/SetupApi.ts`; this is the shape.

| endpoint             | does                                                    |
| -------------------- | ------------------------------------------------------- |
| `GET  …/state`       | where this machine stands, and its pre-flight checks    |
| `POST …/probe`       | checks a candidate hub over ssh (read-only)             |
| `POST …/plan`        | everything setup would do, before anything is written   |
| `POST …/apply`       | does it, as a job; or resumes or abandons a stopped run |
| `POST …/invite`      | the line another machine runs to join                   |
| `POST …/notify-test` | once set up: one test alert, as `t3-fleet notify test`  |

Progress arrives as the existing `job` events on `/api/events`. A plan is only
applied while nothing it read has changed; if something has, apply refuses it
(409 with `x-t3-fleet-error: stale-plan`) and the wizard says so, with a button
to make the plan again. The new plan is shown to review; choices made on the
old one carry over where the same conflict and choice are still there, and
credentials typed in stay for the names it still asks for. Every other
refusal shows the server's own words (SetupApi.ts lists the statuses).

## Security

- **Local only.** The server listens on 127.0.0.1 and answers only the tab it
  opened, with a one-use ticket in the URL. The ticket is spent by the first
  load; a copied URL does not work.
- **Secrets are typed in the browser and encrypted before the first step.**
  The values go to the server once, with the apply request, and are encrypted
  to this machine's key before anything else runs. They are never in job
  events, logs, or the saved run.
- **The probe is read-only.** It runs a fixed set of read commands over ssh
  and changes nothing on the hub.
- **Hub bring-up is shown before it runs.** What the hub will be asked to do
  is on the plan screen as plain steps. Nothing touches it until the user
  confirms the plan.
- **Only an authority sets up a hub.** Plan, apply, resume and each step of
  the bring-up that changes the fleet refuse unless this machine is an
  authority. The hub's own proposal is approved unattended only when it is
  exactly its proposed secrets; anything else, its node file included, waits
  for review.
- **The hub gets the build the wizard started with.** Its SHA-256 is kept
  from the start, the file is refused if it changed since, and the hub
  checks what arrived against it before installing.
- **The app on the hub opens only through tailscale serve.** The relay asks
  the hub's kernel whose socket made each connection: on Linux root's or
  tailscaled's user's (`/proc/net/tcp`); on macOS root's (the standalone
  app's system extension, or `tailscaled` as a daemon; the TCP table from
  `sysctl net.inet.tcp.pcblist_n`, which needs no root), or the App Store
  app's network extension, which runs as the logged-in user and is let in
  only as that process, by its code signature (`HubUi.ts`). Anything not
  placed is refused. A hub that cannot tell (`tailscaled` run as a user on a
  Mac, or another OS) serves the app to no one: the probe says so on the hub
  step ("The fleet app will open locally on this computer instead",
  `UiProbe.app`), admission writes `[ui] hosted = false`, the done screen
  gets no `fleetUrl`, and `t3-fleet ui` serves the app on each machine.
- **Ssh is yours.** The wizard uses the ssh the user already has (their
  config, keys and agent). It does not store a key or a password.

## Resume and abandon

Once the user confirms, the whole run is decided and saved, as with
`t3-fleet setup`. If it stops part-way, the wizard opens on it (`unfinished`)
and says how far it got. Resume does exactly what was decided, from there;
abandon drops the run and says what it had already done. What it did stays,
and the next setup finishes it, with one exception: a hub whose bring-up did
not finish is taken out of the fleet again (its node file and key, `[relay]`,
`[ui]` and the relay token, whichever its admission added), each as a new
commit, so no machine is left pointed at a hub that never came up. The MCP
hub (`[defaults.mcp]`) is only switched on once the hub has synced, so there
is nothing of it to undo. `t3-fleet setup --resume` and `--abandon` do the
same from the terminal, the hub's part included. One process applies a run
at a time: another `t3-fleet ui` or `setup --resume` waits until it is done.

## The hub boundary

Two sides, kept apart:

- **Authority side** (this computer): the wizard, the plan, the secrets'
  decryption, the repository, approving changes. Everything the user decides
  happens here.
- **Hub side** (over ssh): a T3 Fleet install, the machine's own key, the
  relay, the MCP hub. It runs things; it holds only what the fleet gives it,
  and it is brought up from here, not by running the wizard on it.

If the hub is down, every machine still syncs from the repository. The hub
only makes things faster.

## Open questions

- **Several hubs.** The wizard sets up one. Whether it should offer a second
  for a fleet that spans sites is open.
- **No ssh to the hub.** A hub you can only reach through a console or a cloud
  agent could get a pasted command instead of an ssh bring-up. Not decided.
- **A hub that is already running.** How the wizard treats a machine that
  already has a relay (adopt it, or ask to replace it) depends on the
  implementation and is not settled.
