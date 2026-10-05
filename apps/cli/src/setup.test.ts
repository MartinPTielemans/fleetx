// The terminal's switches parse into the same choices the wizard sends: one engine, two front ends.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { upkeepFor } from "@t3-fleet/core/setup/Apply";
import { upkeepOf } from "@t3-fleet/core/setup/Wizard";
import { UPKEEP_DEFAULTS } from "@t3-fleet/core/Upkeep";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Command } from "effect/unstable/cli";
import { describe, expect, it } from "vite-plus/test";

import { plannedSettings, setupFlags, upkeepFlags } from "./setup.ts";

/** What `t3-fleet setup <args>` parses to, without running setup. */
const parsed = async (args: ReadonlyArray<string>) => {
  let flags: Parameters<typeof upkeepFlags>[0] & {
    readonly mcpHub: Option.Option<boolean>;
    readonly relay: boolean;
  } = {
    autoUpdate: Option.none(),
    notify: Option.none(),
    ntfy: Option.none(),
    mcpHub: Option.none(),
    relay: false,
  };
  const probe = Command.make("setup", setupFlags).pipe(
    Command.withHandler((f) => Effect.sync(() => void (flags = f))),
  );
  await Effect.runPromise(
    Command.runWith(probe, { version: "test" })(args).pipe(Effect.provide(NodeServices.layer)),
  );
  return flags;
};

const URL = "https://ntfy.sh/t3fleet0abcdefghijklmnopqrstuvw";
const first = { mode: "first" as const, fleetNtfy: false, canNotify: true };

describe("t3-fleet setup's switches", () => {
  it("parse --mcp-hub, --auto-update/--no-auto-update, --notify/--no-notify and --ntfy", async () => {
    const none = await parsed([]);
    expect([none.mcpHub, none.autoUpdate, none.notify, none.ntfy].every(Option.isNone)).toBe(true);
    const all = await parsed(["--relay", "--mcp-hub", "--no-auto-update", "--no-notify", "--ntfy"]);
    expect(all.relay).toBe(true);
    expect(all.mcpHub).toEqual(Option.some(true));
    expect(all.autoUpdate).toEqual(Option.some(false));
    expect(all.notify).toEqual(Option.some(false));
    expect(all.ntfy).toEqual(Option.some(true));
    expect((await parsed(["--auto-update", "--notify"])).autoUpdate).toEqual(Option.some(true));
  });

  it("decide what the wizard's matching request decides", async () => {
    const flags = await parsed(["--no-auto-update", "--no-notify", "--ntfy"]);
    const wanted = upkeepFlags(flags, first);
    expect(wanted).toEqual({ autoUpdate: false, desktop: false, ntfy: true });
    const request = {
      repo: { kind: "local" as const },
      node: "laptop",
      hub: null,
      extras: [],
      autoUpdate: false,
      notify: { desktop: false, ntfy: URL },
    };
    expect(upkeepFor("first", { autoUpdate: false, desktop: false, ntfy: URL })).toEqual(
      upkeepOf("first", request),
    );
  });

  it("ask what they don't name, with the wizard's defaults; a joining or set-up machine changes only what is named", async () => {
    expect(upkeepFlags(await parsed([]), first)).toEqual({
      autoUpdate: "ask",
      desktop: "ask",
      ntfy: "ask",
    });
    expect(UPKEEP_DEFAULTS).toEqual({
      autoUpdate: true,
      desktop: true,
      ntfy: false,
      mcpHub: false,
    });
    // A hub set up over ssh has no screen: no notification there unless asked.
    expect(upkeepFlags(await parsed([]), { ...first, canNotify: false }).desktop).toBe(false);
    expect(upkeepFlags(await parsed([]), { ...first, mode: "join" }).autoUpdate).toBe(null);
    expect(upkeepFlags(await parsed([]), { ...first, mode: "again" })).toEqual({
      autoUpdate: null,
      desktop: false,
      ntfy: false,
    });
    expect(upkeepFlags(await parsed(["--ntfy"]), { ...first, mode: "again" }).ntfy).toBe(true);
    // A fleet that pushes to ntfy already keeps its topic.
    expect(upkeepFlags(await parsed(["--ntfy"]), { ...first, fleetNtfy: true }).ntfy).toBe(false);
  });

  it("show under --plan's Settings what setup would set: the flags given, defaults for the rest", async () => {
    const here = { ...first, node: "laptop" };
    expect(plannedSettings(await parsed([]), here)).toEqual([
      expect.stringContaining("Keep things up to date automatically"),
      "Notify you on laptop for every fleet alert ([notify] desktop)",
    ]);
    const chosen = plannedSettings(
      await parsed(["--relay", "--mcp-hub", "--no-auto-update", "--no-notify", "--ntfy"]),
      here,
    );
    expect(chosen[0]).toContain("laptop");
    expect(chosen.slice(1)).toEqual([
      expect.stringContaining("Leave updates for you to apply"),
      expect.stringContaining("Push every fleet alert to your phone with ntfy"),
    ]);
    // Joining keeps the fleet's [fleet] apply: nothing to say about it.
    expect(plannedSettings(await parsed([]), { ...here, mode: "join" })).toEqual([
      "Notify you on laptop for every fleet alert ([notify] desktop)",
    ]);
  });
});
