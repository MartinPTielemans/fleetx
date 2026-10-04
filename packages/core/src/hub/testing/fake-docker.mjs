// A stand-in for the docker CLI, for the hub's container tests without Docker.
// State lives in $FAKE_DOCKER_DIR/containers.json; every command is appended
// to $FAKE_DOCKER_DIR/log. Containers never run anything.
//   $FAKE_DOCKER_DIR/conflict-once  the next `run` fails with a name conflict,
//                                   as if another hub had just created that
//                                   container (with a run label not its own)
//   FAKE_DOCKER_SLOW_RM_MS          `rm` takes this long
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_DOCKER_DIR;
const file = join(dir, "containers.json");
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
const save = (c) => writeFileSync(file, JSON.stringify(c));
const args = process.argv.slice(2);
appendFileSync(join(dir, "log"), `${args.join(" ")}\n`);

const container = (labels, port, running = true) => ({
  State: { Running: running, Status: running ? "running" : "created" },
  Config: { Labels: labels },
  HostConfig: { PortBindings: port === null ? {} : { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }] } },
});

const [command, ...rest] = args;
const containers = load();
if (command === "version") {
  console.log("27.0.0");
} else if (command === "inspect") {
  const name = rest.at(-1);
  if (containers[name] === undefined) {
    console.error(`Error: No such container: ${name}`);
    process.exit(1);
  }
  console.log(JSON.stringify([containers[name]]));
} else if (command === "ps") {
  console.log(Object.keys(containers).join("\n"));
} else if (command === "rm") {
  const name = rest.at(-1);
  const ms = Number(process.env.FAKE_DOCKER_SLOW_RM_MS ?? 0);
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  const now = load();
  delete now[name];
  save(now);
} else if (command === "start") {
  const name = rest.at(-1);
  if (containers[name] === undefined) process.exit(1);
  containers[name].State = { Running: true, Status: "running" };
  save(containers);
} else if (command === "rename") {
  containers[rest[1]] = containers[rest[0]];
  delete containers[rest[0]];
  save(containers);
} else if (command === "run") {
  const name = rest[rest.indexOf("--name") + 1];
  const labels = {};
  rest.forEach((a, i) => {
    if (a === "--label") {
      const [k, ...v] = rest[i + 1].split("=");
      labels[k] = v.join("=");
    }
  });
  const port = Number(rest[rest.indexOf("-p") + 1].split(":")[1]);
  if (existsSync(join(dir, "conflict-once"))) {
    rmSync(join(dir, "conflict-once"));
    containers[name] = container({ ...labels, "dev.t3-fleet.run": "someone-else" }, port);
    save(containers);
    console.error(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use by container "abc".`);
    process.exit(125);
  }
  if (containers[name] !== undefined) {
    console.error(`docker: Error response from daemon: Conflict. The container name "/${name}" is already in use.`);
    process.exit(125);
  }
  containers[name] = container(labels, port);
  save(containers);
  console.log("0123456789abcdef");
} else {
  console.error(`fake docker: unknown command ${command}`);
  process.exit(2);
}
