#!/usr/bin/env bash
# A member reports the same alert through an SSH tunnel to a real relay, then
# repeats after the relay restarts. Only a local ntfy-compatible sink receives it.
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-wiznot-notify}
compose() { docker compose -f notify-compose.yml "$@"; }
on() { local node=$1; shift; compose exec -T -u dev "$node" "$@"; }
cleanup() { compose down -v -t 1 >/dev/null 2>&1; }
trap cleanup EXIT
(cd ../.. && pnpm --filter t3-fleet build > /var/tmp/wiznot-build.log 2>&1)
compose up -d --build > /var/tmp/wiznot-docker.log 2>&1
compose exec -T hub bash -c 'ssh-keygen -q -t ed25519 -N "" -f /keys/id && chmod 644 /keys/id*'
for node in hub member; do
  compose exec -T "$node" bash -c '
    install -o dev -g dev -m 600 /keys/id /home/dev/.ssh/id_ed25519
    install -o dev -g dev -m 644 /keys/id.pub /home/dev/.ssh/authorized_keys
    printf "Host *\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n" > /home/dev/.ssh/config
    chown dev /home/dev/.ssh/config'
done
on hub bash -c '
  mkdir -p ~/fleet/nodes ~/.config/t3-fleet
  git init -q -b main ~/fleet
  git init -q --bare -b main ~/origin.git
  git -C ~/fleet remote add origin ~/origin.git
  printf "[relay]\nurl = \"http://127.0.0.1:8399\"\n[notify]\ndesktop = []\nntfy = \"PUSH_URL\"\n" > ~/fleet/t3-fleet.toml
  printf "roles = [\"relay\"]\n" > ~/fleet/nodes/hub.toml
  printf "roles = [\"member\"]\n" > ~/fleet/nodes/member.toml
  git -C ~/fleet add .
  git -C ~/fleet -c user.name=test -c user.email=test@localhost commit -qm fleet
  git -C ~/fleet push -q origin main
  printf "repo = \"~/fleet\"\nnode = \"hub\"\n" > ~/.config/t3-fleet/config.toml
  printf "T3_FLEET_RELAY_TOKEN=wiznot-test\nPUSH_URL=http://sink:8080/topic\n" > ~/.config/t3-fleet/secrets.env
  chmod 600 ~/.config/t3-fleet/secrets.env'
start() {
  on hub bash -c 'nohup node /t3-fleet/bin.mjs relay serve > /tmp/relay.log 2>&1 &'
  on member bash -c 'ssh -fN -o ExitOnForwardFailure=yes -L 18399:127.0.0.1:8399 dev@hub'
  for attempt in $(seq 1 40); do
    if on member node -e 'fetch("http://127.0.0.1:18399/health").then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then return; fi
    sleep 0.25
  done
  on hub cat /tmp/relay.log
  exit 1
}
start
# Store the identity once. Every invocation, and the restarted relay, sees the same alert.
on member node -e 'require("node:fs").writeFileSync("/tmp/report.json",JSON.stringify({node:"member",at:Date.now(),rev:"abc",result:"ok",streak:0,message:"synced",observation:null,findings:[],applied:[],alerts:[{node:"member",at:Date.now(),kind:"problem",message:"test provider unhealthy"}]}))'
report() {
  on member node -e 'fetch("http://127.0.0.1:18399/report",{method:"POST",headers:{authorization:"Bearer wiznot-test"},body:require("node:fs").readFileSync("/tmp/report.json")}).then(r=>{if(r.status!==204)throw Error("report status "+r.status)}).catch(e=>{console.error(e);process.exit(1)})'
}
report
report
compose restart hub >/dev/null
on member bash -c 'pkill -x ssh || true' || true
start
report
report
on member node -e 'fetch("http://sink:8080/requests").then(r=>r.json()).then(a=>{if(a.length!==1||a[0].body!=="test provider unhealthy"||a[0].priority!=="4"||a[0].tags!=="warning")throw Error(JSON.stringify(a));console.log("PASS: one relay-owned ntfy push after repeated reports and restart",JSON.stringify(a))}).catch(e=>{console.error(e);process.exit(1)})'
# The explicit CLI test is a second notification, independent of the alert ledger.
on hub node /t3-fleet/bin.mjs notify test
on member node -e 'fetch("http://sink:8080/requests").then(r=>r.json()).then(a=>{if(a.length!==2||a[1].title!=="T3 Fleet: notification test"||a[1].priority!=="2")throw Error(JSON.stringify(a));console.log("PASS: notify test sent one explicit test")}).catch(e=>{console.error(e);process.exit(1)})'
# A rejected explicit test exits nonzero and leaves a visible, sanitized status.
on hub bash -c 'sed -i "s|http://sink:8080/topic|http://sink:8080/reject|" ~/.config/t3-fleet/secrets.env'
if on hub node /t3-fleet/bin.mjs notify test; then
  echo "FAIL: rejected notification test exited successfully" >&2
  exit 1
fi
status=$(on hub node /t3-fleet/bin.mjs status --all)
printf '%s\n' "$status" | grep -q 'ntfy rejected notification (HTTP 403)'
if printf '%s\n' "$status" | grep -q 'http://sink'; then
  echo "FAIL: status exposed the topic URL" >&2
  exit 1
fi
echo "PASS: rejected test exits nonzero and status reports failure without the secret"
