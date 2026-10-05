// Node harness outside the Effect app. Only the throwaway host created by remote-hub.sh.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../packages/core/package.json", import.meta.url));
const Effect = await import(require.resolve("effect/Effect"));
const NodeServices = await import(require.resolve("@effect/platform-node/NodeServices"));
const { probeHub, bringUpHub } = await import("../../packages/core/src/setup/Remote.ts");
const container = process.env.WIZREM_CONTAINER;
assert(container?.startsWith("wizrem-"));
assert(process.env.WIZREM_SSH_CONFIG?.startsWith("/var/tmp/wizrem-"));
const docker = (...args) =>
  execFileSync("docker", ["exec", container, ...args], { encoding: "utf8" });
const ssh = (script) => execFileSync("ssh", ["wizrem-hub", script], { encoding: "utf8" });
const state = () => ssh('find "$HOME" -type f -exec sha256sum {} + | sort');
const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)));

const before = state();
const probe = await run(probeHub("wizrem-hub"));
assert.equal(before, state());
assert.equal(probe.reachable, true);
assert.equal(probe.node.state, "ok");
assert.equal(probe.git.state, "ok");
assert.equal(probe.service.state, "missing");
assert.equal(probe.ready, false);
for (const key of ["t3", "tailscale", "docker"]) {
  assert.equal(probe[key].state, "missing");
  assert(probe[key].remedy);
}
console.log("PROBE", JSON.stringify(probe));
console.log("PASS probe left the hub user's files unchanged");

// This container has no systemd. Apply is exercised here to test join/resume;
// a real wizard must require probe.ready before offering an always-on hub.
const bundle = readFileSync(new URL("../../apps/cli/dist/bin.mjs", import.meta.url), "utf8");
const steps = [];
const input = {
  ssh: "wizrem-hub",
  node: "server",
  repoUrl: "/srv/remote/fleet.git",
  relayUrl: null,
  onStep: (step) =>
    Effect.sync(() => {
      steps.push(step);
      console.log("STEP", step);
    }),
};
// Make publication fail after clone/content/config/key creation, as a network outage would.
docker("chmod", "-R", "a-w", "/srv/remote/fleet.git");
const failed = await run(bringUpHub(input).pipe(Effect.result));
assert.equal(failed._tag, "Failure");
assert(!steps.includes("The hub has already joined the fleet"));
console.log("PASS interrupted join reported failure without an authority key read");
const key = () =>
  ssh('node "$HOME/.local/share/t3-fleet/t3-fleet.mjs" secrets init').match(
    /public: (age1[0-9a-z]+)/,
  )?.[1];
const recipientBeforeResume = key();
docker("chmod", "-R", "u+w", "/srv/remote/fleet.git");
steps.length = 0;
const joined = await run(bringUpHub(input));
assert.equal(joined, undefined);
assert(steps.includes("Resuming the hub's unfinished setup"));
assert.match(key(), /^age1[0-9a-z]+$/);
assert.equal(key(), recipientBeforeResume);
console.log("PASS unfinished join resumed with the same saved plan");
const roles = ssh('cat "$HOME/fleet/nodes/server.toml"');
assert(roles.includes('"member"') && roles.includes('"relay"'));
console.log("PASS hub has member and relay roles");
const installed = ssh('sha256sum "$HOME/.local/share/t3-fleet/t3-fleet.mjs"').split(" ")[0];
assert.equal(installed, createHash("sha256").update(bundle).digest("hex"));
console.log("PASS installed bundle equals the authority build byte for byte");
steps.length = 0;
const again = await run(bringUpHub(input));
assert.equal(again, undefined);
assert.equal(key(), recipientBeforeResume);
assert(steps.includes("The hub has already joined the fleet"));
assert(!steps.includes("Joining the fleet"));
console.log("PASS completed rerun skipped join; the separate authority key read stayed stable");
console.log(
  "NOT VERIFIED service startup, Tailscale HTTPS, Docker MCP servers, authority approval and secrets grants",
);
