// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { t3FromNix, t3Program } from "./Nix.ts";

describe("t3Program", () => {
  it("is the program, or the script node runs, and nothing for T3's own runtime", () => {
    expect(t3Program("/nix/store/abc-t3code/bin/t3 serve")).toBe("/nix/store/abc-t3code/bin/t3");
    expect(
      t3Program("/nix/store/abc-nodejs-24/bin/node /home/u/.local/lib/t3/bin.mjs --port 3773"),
    ).toBe("/home/u/.local/lib/t3/bin.mjs");
    expect(t3Program("/home/u/.t3/runtime/versions/0.0.46-nightly.20261003.2632/t3 serve")).toBe(
      null,
    );
  });
});

describe("t3FromNix", () => {
  it("follows a profile link into the store, and ignores store paths among the arguments", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "t3f-nix-")));
    const store = join(root, "store") + "/";
    mkdirSync(join(store, "abc-t3code/bin"), { recursive: true });
    writeFileSync(join(store, "abc-t3code/bin/t3"), "");
    mkdirSync(join(root, "profile/bin"), { recursive: true });
    symlinkSync(join(store, "abc-t3code/bin/t3"), join(root, "profile/bin/t3"));
    writeFileSync(join(root, "t3"), "");
    const fromNix = (commandLine: string) =>
      Effect.runPromise(t3FromNix(commandLine, store).pipe(Effect.provide(NodeServices.layer)));

    expect(await fromNix(`${join(root, "profile/bin/t3")} serve`)).toBe(true);
    expect(await fromNix(`/usr/bin/node ${join(root, "profile/bin/t3")}`)).toBe(true);
    expect(await fromNix(`${join(root, "t3")} serve --data ${store}x`)).toBe(false);
  });
});
