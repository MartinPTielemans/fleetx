// Plain tests on temp directories: the migration is a shell script, run here with bash as a fix would.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { migrateDirs } from "./areas/Engine.ts";
import { applyAccepted } from "./Memory.ts";
import { requestHeaders } from "./models/Forward.ts";
import { configDir, readHeader, SH_CONFIG_DIR, stateDir } from "./Names.ts";

const home = () => mkdtempSync(join(tmpdir(), "t3-fleet-home-"));
const put = (path: string, text: string) => {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, text);
};
const migrate = (h: string, legacy: ReadonlyArray<"config" | "state" | "share">) =>
  execFileSync("bash", ["-s"], { input: migrateDirs(legacy), env: { ...process.env, HOME: h }, encoding: "utf8" });
const isLink = (path: string) => lstatSync(path).isSymbolicLink();

describe("data directories", () => {
  it("stay fleetx's until they move, then are T3 Fleet's", () => {
    const h = home();
    expect(configDir(h)).toBe(`${h}/.config/t3-fleet`);
    mkdirSync(`${h}/.config/fleetx`, { recursive: true });
    expect(configDir(h)).toBe(`${h}/.config/fleetx`);
    // Something wrote to the new name early: the old one still counts until the migration.
    mkdirSync(`${h}/.config/t3-fleet`, { recursive: true });
    expect(configDir(h)).toBe(`${h}/.config/fleetx`);
    migrate(h, ["config"]);
    expect(configDir(h)).toBe(`${h}/.config/t3-fleet`);
    expect(stateDir(h)).toBe(`${h}/.local/state/t3-fleet`);
  });

  it("resolve the same way in shell", () => {
    const h = home();
    const resolve = () => execFileSync("sh", ["-c", `echo "${SH_CONFIG_DIR}"`], { env: { ...process.env, HOME: h }, encoding: "utf8" }).trim();
    expect(resolve()).toBe(`${h}/.config/t3-fleet`);
    mkdirSync(`${h}/.config/fleetx`, { recursive: true });
    expect(resolve()).toBe(`${h}/.config/fleetx`);
    migrate(h, ["config"]);
    expect(resolve()).toBe(`${h}/.config/t3-fleet`);
  });
});

describe("the migration", () => {
  it("moves a directory and leaves a link at the old name", () => {
    const h = home();
    put(`${h}/.config/fleetx/secrets.env`, "A=1\n");
    put(`${h}/.local/state/fleetx/hub/tokens.age`, "tokens");
    migrate(h, ["config", "state"]);
    expect(readFileSync(`${h}/.config/t3-fleet/secrets.env`, "utf8")).toBe("A=1\n");
    expect(readFileSync(`${h}/.local/state/t3-fleet/hub/tokens.age`, "utf8")).toBe("tokens");
    expect(isLink(`${h}/.config/fleetx`)).toBe(true);
    expect(readFileSync(`${h}/.config/fleetx/secrets.env`, "utf8")).toBe("A=1\n");
    // A second run finds nothing to do.
    expect(migrate(h, ["config", "state"])).toBe("");
  });

  it("merges into a directory both names have, the new files winning, the old one kept", () => {
    const h = home();
    put(`${h}/.config/fleetx/age-key.txt`, "key");
    put(`${h}/.config/fleetx/config.toml`, "old");
    put(`${h}/.config/t3-fleet/config.toml`, "new");
    migrate(h, ["config"]);
    expect(readFileSync(`${h}/.config/t3-fleet/config.toml`, "utf8")).toBe("new");
    expect(readFileSync(`${h}/.config/t3-fleet/age-key.txt`, "utf8")).toBe("key");
    expect(isLink(`${h}/.config/fleetx`)).toBe(true);
    expect(readdirSync(`${h}/.config`).some((d) => d.startsWith("fleetx.migrated."))).toBe(true);
  });

  it("moves the bundle directory only once the new build is there, and keeps fleetx.mjs pointing at it", () => {
    const h = home();
    put(`${h}/.local/share/fleetx/fleetx.mjs`, "old build");
    migrate(h, ["share"]);
    expect(isLink(`${h}/.local/share/fleetx`)).toBe(false);
    put(`${h}/.local/share/t3-fleet/t3-fleet.mjs`, "new build");
    migrate(h, ["share"]);
    expect(isLink(`${h}/.local/share/fleetx`)).toBe(true);
    expect(readlinkSync(`${h}/.local/share/t3-fleet/fleetx.mjs`)).toBe("t3-fleet.mjs");
    expect(readFileSync(`${h}/.local/share/fleetx/fleetx.mjs`, "utf8")).toBe("new build");
  });

  it("moves nothing when the merge comes up short", () => {
    const h = home();
    put(`${h}/.config/fleetx/age-key.txt`, "key");
    put(`${h}/.config/fleetx/secrets.env`, "A=1\n");
    put(`${h}/.config/t3-fleet/config.toml`, "new");
    execFileSync("chmod", ["000", `${h}/.config/fleetx/secrets.env`]);
    expect(() => migrate(h, ["config"])).toThrow();
    execFileSync("chmod", ["600", `${h}/.config/fleetx/secrets.env`]);
    expect(isLink(`${h}/.config/fleetx`)).toBe(false);
    expect(readFileSync(`${h}/.config/fleetx/secrets.env`, "utf8")).toBe("A=1\n");
    expect(configDir(h)).toBe(`${h}/.config/fleetx`);
  });

  it("leaves an already linked directory alone", () => {
    const h = home();
    mkdirSync(`${h}/.config/t3-fleet`, { recursive: true });
    symlinkSync(`${h}/.config/t3-fleet`, `${h}/.config/fleetx`);
    expect(migrate(h, ["config"])).toBe("");
  });
});

describe("headers between machines", () => {
  it("are read under either name, and neither is forwarded upstream", () => {
    expect(readHeader({ "x-fleetx-relay-token": "old" }, "relay-token")).toBe("old");
    expect(readHeader({ "x-t3-fleet-relay-token": "new", "x-fleetx-relay-token": "old" }, "relay-token")).toBe("new");
    expect(requestHeaders({ "x-t3-fleet-relay-token": "a", "x-fleetx-egress-base": "b", accept: "*/*" })).toEqual({ accept: "*/*" });
  });
});

describe("accepted differences from before the rename", () => {
  it("still match the engine's renamed keys", () => {
    const finding = { node: "box", key: "engine-outdated", severity: "warn" as const, area: "engine", title: "different build" };
    const [noted] = applyAccepted([finding], [{ id: "box:fleetx-outdated", reason: "pinned on purpose" }]);
    expect(noted).toMatchObject({ severity: "info", detail: "accepted: pinned on purpose" });
  });
});

