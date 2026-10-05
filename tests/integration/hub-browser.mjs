// What a browser does with the app on the hub, from the command line: node hub-browser.mjs <url> <what> [...]
//   page                  GET /: status and the page's text
//   session               POST /api/session as the app does
//   fix <node> <area>     apply that machine's first fixable finding in <area>, as the app does; the job
//   approve <node>        try to approve a proposal
//   forge <node> <area>   as a member holding the relay token ($TOKEN): ask the relay directly to run that
//                         machine's first fixable finding in <area>, id and digest worked out from
//                         /fleet, its interruption "acknowledged"; the relay's answer
import { createHash } from "node:crypto";

const [base, what, ...args] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (value) => console.log(JSON.stringify(value));

const session = async () => {
  const r = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "x-t3-fleet-hub": "1", origin: base },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`session: ${r.status} ${text}`);
  return JSON.parse(text).token;
};
const api = async (token, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-t3-fleet-token": token, origin: base },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, json: () => JSON.parse(text) };
};

if (what === "page") {
  const r = await fetch(`${base}/`);
  out({ status: r.status, text: (await r.text()).slice(0, 2000) });
} else if (what === "session") {
  const r = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "x-t3-fleet-hub": "1", origin: base },
  });
  out({ status: r.status, text: await r.text() });
} else if (what === "fix") {
  const [node, area] = args;
  const token = await session();
  let finding;
  for (let i = 0; i < 60 && finding === undefined; i++) {
    const status = (await api(token, "/api/status?fresh=1")).json();
    finding = status.findings.find(
      (f) => f.node === node && f.area === area && f.fix !== undefined,
    );
    if (finding === undefined) await sleep(2000);
  }
  if (finding === undefined)
    throw new Error(`no fixable ${area} finding on ${node} in what the hub shows`);
  const plan = (await api(token, "/api/fixes/plan", { ids: [finding.id] })).json();
  const started = await api(token, "/api/fixes", {
    fixes: plan.fixes.map((f) => ({ id: f.id, digest: f.digest })),
    acknowledged: plan.fixes.filter((f) => f.disrupts !== undefined).map((f) => f.id),
  });
  if (started.status !== 202) throw new Error(`apply: ${started.status} ${started.text}`);
  const id = started.json().id;
  for (let i = 0; i < 300; i++) {
    const job = (await api(token, "/api/jobs")).json().find((j) => j.id === id);
    if (job.state === "done" || job.state === "failed") {
      out({ finding: finding.id, command: finding.fix.command, job });
      process.exit(0);
    }
    await sleep(1000);
  }
  throw new Error("the job did not finish");
} else if (what === "approve") {
  const token = await session();
  const r = await api(token, `/api/proposals/${args[0]}/approve`, { change: "e".repeat(64) });
  out({ status: r.status, text: r.text });
} else if (what === "forge") {
  const [node, area] = args;
  const auth = { authorization: `Bearer ${process.env.TOKEN}` };
  const states = await (await fetch(`${base}/fleet`, { headers: auth })).json();
  const finding = states
    .find((s) => s.node === node)
    ?.findings.find((f) => f.area === area && f.fix !== undefined);
  if (finding === undefined) throw new Error(`no fixable ${area} finding on ${node} in /fleet`);
  // Fix.ts fixDigest, from what /fleet hands every member.
  const { command, on, disrupts, safe } = finding.fix;
  const parts = [
    finding.node,
    on ?? finding.node,
    command,
    disrupts ?? "-",
    safe ? "safe" : "unsafe",
  ];
  const digest = createHash("sha256")
    .update(parts.map((p) => `${p.length}:${p}`).join(""))
    .digest("hex");
  const id = `${finding.node}:${finding.key}`;
  const r = await fetch(`${base}/fixes`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ node, fixes: [{ id, digest }], acknowledged: [id] }),
  });
  out({ id, status: r.status, text: (await r.text()).slice(0, 500) });
}
