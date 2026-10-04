// Setup's discovery in a temporary home, with agent CLIs that record being run.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { ProbeServices } from "../Area.ts";
import { discover } from "./Discover.ts";

const run = <A, E>(effect: Effect.Effect<A, E, ProbeServices>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
  );

const home = fs.mkdtempSync(join(tmpdir(), "t3-fleet-discover-"));
const ran = join(home, "ran");
const saved = { HOME: process.env["HOME"], PATH: process.env["PATH"] };
/** An executable that, run at all, writes where it was run from: what `codex --version` does to ~/.codex. */
const agent = (path: string) => {
  fs.mkdirSync(join(path, ".."), { recursive: true });
  fs.writeFileSync(path, `#!/bin/sh\necho "$0 $*" >> ${ran}\necho 9.9.9\n`, { mode: 0o755 });
};
beforeAll(() => {
  // Codex from npm, Claude from its native installer, and both in ~/.local/bin as setup finds them.
  const pkg = join(home, "npm/lib/node_modules/@openai/codex");
  agent(join(pkg, "bin/codex.js"));
  fs.writeFileSync(join(pkg, "package.json"), '{"name":"@openai/codex","version":"0.160.0"}');
  agent(join(home, ".local/share/claude/versions/2.1.288/claude"));
  fs.mkdirSync(join(home, ".local/bin"), { recursive: true });
  fs.symlinkSync(join(pkg, "bin/codex.js"), join(home, ".local/bin/codex"));
  fs.symlinkSync(
    join(home, ".local/share/claude/versions/2.1.288/claude"),
    join(home, ".local/bin/claude"),
  );
  process.env["HOME"] = home;
  process.env["PATH"] = `${join(home, ".local/bin")}:/usr/bin:/bin`;
});
afterAll(() => {
  process.env["HOME"] = saved.HOME;
  process.env["PATH"] = saved.PATH;
});

describe("discover", () => {
  it("tells how each agent CLI was installed, and its version, without running either", async () => {
    const found = await run(discover({ taken: [], managed: null }));
    expect(found.agents.map((a) => [a.name, a.version, a.installedBy])).toEqual([
      ["claude", "2.1.288", expect.anything()],
      ["codex", "0.160.0", "npm"],
    ]);
    expect(fs.existsSync(ran)).toBe(false);
    expect(fs.existsSync(join(home, ".codex"))).toBe(false);
  });
});
