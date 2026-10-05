// Drives `t3-fleet ui`'s setup API the way the app does (apps/ui/src/lib/api.ts):
//   node driver.mjs <base> ticket <ticket>        trade the link's one-use ticket for a token
//   node driver.mjs <base> setup <plan request>   probe, plan, apply; follow both jobs to the end
//   node driver.mjs <base> invite <node>          the line that machine runs
//   node driver.mjs <base> on-hub-step <cmd>      once setup-hub has started, run <cmd> (sh -c) once
// The token is kept in /tmp/wizfe-token. Prints what it got; exits 1 when a job failed.
import { execSync } from "node:child_process";
import fs from "node:fs";

const [base, what, ...args] = process.argv.slice(2);
const TOKEN = "/tmp/wizfe-token";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      "x-t3-fleet-token": fs.readFileSync(TOKEN, "utf8").trim(),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${text}`);
  return json ?? text;
};

if (what === "ticket") {
  const r = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "x-t3-fleet-ticket": args[0] },
  });
  if (!r.ok) throw new Error(`session: ${r.status} ${await r.text()}`);
  fs.writeFileSync(TOKEN, (await r.json()).token);
  console.log("token saved");
} else if (what === "setup") {
  const request = JSON.parse(args[0]);
  const state = await call("GET", "/api/setup/state");
  console.log(`state: ${state.stage}`);
  const probe = await call("POST", "/api/setup/probe", {
    ssh: request.hub.ssh,
    repo: request.repo.url,
  });
  console.log(`probe: ready ${probe.ready}, relay ${probe.relayUrl}, fleet "${probe.fleet.label}"`);
  if (!probe.ready) throw new Error(`the hub is not ready: ${JSON.stringify(probe)}`);
  const plan = await call("POST", "/api/setup/plan", request);
  console.log(`plan: ${plan.mode}; hub steps:\n  ${plan.hub.steps.join("\n  ")}`);
  console.log(`plan: MCP servers on the hub: ${JSON.stringify(plan.hub.servers ?? null)}`);
  const started = await call("POST", "/api/setup/apply", {
    kind: "plan",
    planId: plan.planId,
    choices: {},
    values: {},
  });
  console.log(`apply: job ${started.jobId}`);
  const seen = new Map();
  let failed = false;
  for (let i = 0; i < 900; i++) {
    const jobs = (await call("GET", "/api/jobs")).filter(
      (j) => j.kind === "setup" || j.kind === "setup-hub",
    );
    for (const j of jobs) {
      const key = `${j.id}:${j.state}:${j.step}`;
      if (!seen.has(key)) {
        seen.set(key, true);
        console.log(
          `  [${j.kind}] ${j.state}${j.step === null ? "" : `: ${j.step}`}${j.error === null ? "" : ` (${j.error})`}`,
        );
      }
    }
    const hub = jobs.find((j) => j.kind === "setup-hub");
    const local = jobs.find((j) => j.kind === "setup");
    if (local?.state === "failed") {
      failed = true;
      break;
    }
    if (hub !== undefined && (hub.state === "done" || hub.state === "failed")) {
      failed = hub.state === "failed";
      break;
    }
    await sleep(1000);
  }
  process.exit(failed ? 1 : 0);
} else if (what === "on-hub-step") {
  for (let i = 0; i < 900; i++) {
    const jobs = await call("GET", "/api/jobs");
    const hub = jobs.find((j) => j.kind === "setup-hub");
    if (hub !== undefined && hub.state === "running") {
      console.log(`setup-hub running (${hub.step}); running: ${args[0]}`);
      execSync(args[0], { stdio: "inherit", shell: "/bin/sh" });
      process.exit(0);
    }
    await sleep(250);
  }
  throw new Error("setup-hub never started");
} else if (what === "invite") {
  console.log((await call("POST", "/api/setup/invite", { node: args[0] })).command);
}
