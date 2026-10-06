#!/usr/bin/env bash
# The setup wizard, end to end, with nothing repaired by hand.
#
# Three throwaway machines with systemd and a lingering user session (as a real
# server or desktop has), on one Docker network:
#   laptop   runs `t3-fleet ui` and drives its setup API the way the app does
#            (e2e/driver.mjs): a new fleet in an empty repository, with laptop's
#            hub on `hub`, its MCP servers hosted there, and pushes to ntfy
#   hub      reached over ssh from laptop; set up by the wizard alone
#   desktop  joins by running the invite line, in a terminal (a pty)
# and stand-ins for what does not run in a container:
#   tailscale       e2e/tailscale: `status` (a MagicDNS name, login me@example.com)
#                   and `serve` (recorded)
#   tailscale serve e2e/serve-tls.mjs on hub, as root, as tailscaled runs: TLS for
#                   hub.tailnet.ts.net on hub's own address, the login by source address
#   ntfy.sh         e2e/sink.mjs, TLS for ntfy.sh; every node maps the name to it
#   GitHub          a bare repository on a shared volume
#   install.sh      the repo's own, fetched by e2e/curl from this build
# The certificates come from a CA made for this run.
#
# What it shows, each without a manual step:
#   B1  after setup, the relay answers on hub and through serve; laptop's listener
#       runs; the app on hub opens for laptop's login; desktop's listener starts
#       once it can read the secrets (its own sync timer, run here instead of
#       waited for); a fix forwarded from the hub runs on desktop
#   B3  a sync laptop's timer starts as the hub's part begins only delays it
#   B8  one alert is exactly one push; nothing is pushed for setup itself, the
#       relay's start or a recovery's own streak
#
# Usage: tests/integration/wizard-e2e.sh  (needs Docker; builds the bundle first;
# about ten minutes). Containers, network and volumes are named wizfe-* and removed
# at the end; WIZFE_KEEP=1 keeps them for a look.
set -euo pipefail
cd "$(dirname "$0")"
P=${WIZFE_PREFIX:-wizfe}
NET=$P-net
IMAGE=$P-node
NODES=(laptop hub desktop)
pass() { printf '\033[32mpass\033[0m %s\n' "$*"; }
fail() {
  printf '\033[31mFAIL\033[0m %s\n' "$*"
  logs
  exit 1
}
uid=""
on() {
  local n=$1
  shift
  docker exec -i -u dev -e HOME=/home/dev -e USER=dev -e LOGNAME=dev \
    -e XDG_RUNTIME_DIR=/run/user/$uid -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus \
    -e NODE_EXTRA_CA_CERTS=/certs/ca.pem -w /home/dev "$P-$n" bash -lc "$*"
}
onroot() {
  local n=$1
  shift
  docker exec -i "$P-$n" bash -c "$*"
}
logs() {
  echo "--- ui.log (laptop)"
  on laptop 'tail -n 40 /tmp/ui.log' 2>/dev/null || true
  for n in "${NODES[@]}"; do
    echo "--- $n: services, serve.log, listen.log, sync.log"
    on "$n" 'systemctl --user list-units "t3-fleet*" --no-legend --all; tail -n 15 ~/.local/state/t3-fleet/serve.log ~/.local/state/t3-fleet/listen.log ~/.local/state/t3-fleet/sync.log' 2>/dev/null || true
  done
  echo "--- pushes"
  pushes || true
}
cleanup() {
  [ "${WIZFE_KEEP:-}" = 1 ] && return
  docker rm -f "$P-sink" "${NODES[@]/#/$P-}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker volume rm "$P-remote" "$P-certs" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

(cd ../.. && ${PNPM:-pnpm} --filter t3-fleet build >/dev/null)
docker build -q -t "$IMAGE" e2e >/dev/null
docker network create "$NET" >/dev/null
docker volume create "$P-remote" >/dev/null
docker volume create "$P-certs" >/dev/null

# A CA for this run, and certificates for hub.tailnet.ts.net (serve) and ntfy.sh (the sink).
docker run --rm -v "$P-certs:/certs" -w /certs "$IMAGE" bash -c '
  set -e
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 2 -subj /CN=wizfe-ca 2>/dev/null
  for pair in hub:hub.tailnet.ts.net ntfy:ntfy.sh; do
    n=${pair%%:*} dns=${pair#*:}
    openssl req -newkey rsa:2048 -nodes -keyout $n.key -out $n.csr -subj /CN=$dns 2>/dev/null
    echo "subjectAltName=DNS:$dns" > $n.ext
    openssl x509 -req -in $n.csr -CA ca.pem -CAkey ca.key -CAcreateserial -out $n.pem -days 2 -extfile $n.ext 2>/dev/null
  done
  chmod 644 *.key'

docker create --name "$P-sink" --network "$NET" -v "$P-certs:/certs:ro" "$IMAGE" node /sink.mjs >/dev/null
docker cp e2e/sink.mjs "$P-sink:/sink.mjs" >/dev/null
docker start "$P-sink" >/dev/null
for n in "${NODES[@]}"; do
  docker run -d --name "$P-$n" --hostname "$n" --network "$NET" --network-alias "$n" \
    --privileged --cgroupns host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
    -e container=docker -v "$P-remote:/srv/remote" -v "$P-certs:/certs:ro" "$IMAGE" >/dev/null
done
ip() { docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$P-$1"; }
HUB_IP=$(ip hub) LAPTOP_IP=$(ip laptop) DESKTOP_IP=$(ip desktop) SINK_IP=$(ip sink)
for n in "${NODES[@]}"; do
  for _ in $(seq 60); do
    docker exec "$P-$n" systemctl is-system-running 2>/dev/null | grep -qE 'running|degraded' && break
    sleep 1
  done
  docker exec "$P-$n" mkdir -p /opt/wizfe /etc/wizfe
  for f in e2e/tailscale e2e/serve-tls.mjs e2e/ptyrun.py e2e/driver.mjs ../../install.sh ../../apps/cli/dist/bin.mjs; do
    docker cp "$f" "$P-$n:/opt/wizfe/" >/dev/null
  done
  onroot "$n" "
    set -e
    mv /opt/wizfe/bin.mjs /opt/wizfe/t3-fleet.mjs
    install -m 755 /opt/wizfe/tailscale /usr/local/bin/tailscale
    cp /certs/ca.pem /usr/local/share/ca-certificates/wizfe.crt && update-ca-certificates >/dev/null 2>&1
    printf '%s hub.tailnet.ts.net\n%s ntfy.sh\n' $HUB_IP $SINK_IP >> /etc/hosts
    echo NODE_EXTRA_CA_CERTS=/certs/ca.pem >> /etc/environment
    echo 'export NODE_EXTRA_CA_CERTS=/certs/ca.pem' > /etc/profile.d/wizfe.sh
    echo me@example.com > /etc/wizfe/login
    chown dev:dev /srv/remote
    install -d -o dev -g dev -m 700 /home/dev/.ssh
    install -d -o dev -g dev /home/dev/.config /home/dev/.config/environment.d
    echo NODE_EXTRA_CA_CERTS=/certs/ca.pem > /home/dev/.config/environment.d/wizfe.conf
    chown dev:dev /home/dev/.config/environment.d/wizfe.conf"
  uid=$(docker exec "$P-$n" id -u dev)
  for _ in $(seq 30); do
    on "$n" 'systemctl --user is-system-running' 2>/dev/null | grep -qE 'running|degraded' && break
    sleep 1
  done
  on "$n" 'systemctl --user set-environment NODE_EXTRA_CA_CERTS=/certs/ca.pem
    git config --global user.name dev && git config --global user.email dev@example.com && git config --global init.defaultBranch main
    ssh-keygen -q -t ed25519 -N "" -f ~/.ssh/id_ed25519'
done

# hub: laptop's key lets it in; serve, as root, in front of where the relay will listen.
docker exec "$P-laptop" cat /home/dev/.ssh/id_ed25519.pub | onroot hub 'cat >> /home/dev/.ssh/authorized_keys && chown dev:dev /home/dev/.ssh/authorized_keys && chmod 600 /home/dev/.ssh/authorized_keys'
on laptop 'ssh-keyscan -t ed25519 hub > ~/.ssh/known_hosts 2>/dev/null'
onroot hub "
  printf '%s=me@example.com\n%s=me@example.com\n' $LAPTOP_IP $DESKTOP_IP > /etc/wizfe/logins
  cat > /etc/systemd/system/wizfe-serve.service <<UNIT
[Service]
ExecStart=/usr/local/bin/node /opt/wizfe/serve-tls.mjs $HUB_IP /certs/hub.pem /certs/hub.key
Restart=always
UNIT
  systemctl daemon-reload && systemctl start wizfe-serve"
# desktop runs the invite line, which fetches install.sh and the build with curl.
onroot desktop 'install -m 755 /dev/stdin /usr/local/bin/curl' < e2e/curl
# laptop: T3 Fleet installed as install.sh installs it, and an empty repository for the fleet.
on laptop 'mkdir -p ~/.local/share/t3-fleet ~/.local/bin && cp /opt/wizfe/t3-fleet.mjs ~/.local/share/t3-fleet/t3-fleet.mjs && ln -sfn ~/.local/share/t3-fleet/t3-fleet.mjs ~/.local/bin/t3-fleet
  git init -q --bare /srv/remote/fleet.git'
pass "laptop, hub and desktop up, with systemd user sessions; serve and the ntfy sink stand in"

pushes() { on laptop "node -e 'fetch(\"https://ntfy.sh/__requests\").then(r=>r.text()).then(console.log)'"; }
count() { pushes | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))'; }

# ── the wizard, on laptop ───────────────────────────────────────────────
docker exec -d -u dev -e HOME=/home/dev -e XDG_RUNTIME_DIR=/run/user/$uid \
  -e DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus -e NODE_EXTRA_CA_CERTS=/certs/ca.pem \
  "$P-laptop" bash -lc 'exec ~/.local/bin/t3-fleet ui --no-open --port 47800 > /tmp/ui.log 2>&1'
ticket=""
for _ in $(seq 30); do
  ticket=$(on laptop "sed -n 's/.*#ticket=\([0-9a-f]*\).*/\1/p' /tmp/ui.log" | head -1)
  [ -n "$ticket" ] && break
  sleep 1
done
[ -n "$ticket" ] || fail "t3-fleet ui printed no link"
API=http://127.0.0.1:47800
on laptop "node /opt/wizfe/driver.mjs $API ticket $ticket" >/dev/null
TOPIC=t3fleet$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
REQUEST="{\"repo\":{\"kind\":\"url\",\"url\":\"/srv/remote/fleet.git\"},\"node\":\"laptop\",\"hub\":{\"ssh\":\"hub\",\"node\":\"hub\",\"mcp\":true},\"extras\":[],\"autoUpdate\":false,\"notify\":{\"desktop\":true,\"ntfy\":\"https://ntfy.sh/$TOPIC\"}}"
# B3: laptop's own sync starts the moment the hub's part does, as its new timer would.
on laptop "node /opt/wizfe/driver.mjs $API on-hub-step 'systemctl --user start --no-block t3-fleet-sync.service'" >/tmp/$P-onhub.log 2>&1 &
if ! on laptop "node /opt/wizfe/driver.mjs $API setup '$REQUEST'" >/tmp/$P-setup.log 2>&1; then
  cat /tmp/$P-setup.log
  fail "the wizard's setup did not finish"
fi
wait || true
cat /tmp/$P-setup.log | sed 's/^/    /'
grep -q 'setup-hub running' /tmp/$P-onhub.log || fail "laptop's sync was not started during the hub's part: $(cat /tmp/$P-onhub.log)"
pass "the wizard set up laptop and brought hub up, laptop's own sync running meanwhile (B3)"

# ── B1: running, with nothing repaired by hand ──────────────────────────
on hub 'systemctl --user is-active --quiet t3-fleet-serve.service' || fail "the relay is not running on hub"
on hub 't3-fleet relay health' >/dev/null || fail "the relay does not answer on hub"
health=$(on laptop "node -e 'fetch(\"https://hub.tailnet.ts.net:8399/health\").then(r=>r.text()).then(console.log,e=>console.log(String(e)))'")
[ "$health" = ok ] || fail "the relay does not answer through serve: $health"
on hub 'grep -q -- "--https=8399 http://127.0.0.1:8399" /tmp/wizfe-serve.log' || fail "the relay's port was not published (tailscale serve)"
on laptop 'systemctl --user is-active --quiet t3-fleet-listen.service' || fail "laptop's listener is not running"
docker cp ./hub-browser.mjs "$P-laptop:/tmp/hub-browser.mjs" >/dev/null
docker cp ./hub-browser.mjs "$P-desktop:/tmp/hub-browser.mjs" >/dev/null
page=$(on laptop 'node /tmp/hub-browser.mjs https://hub.tailnet.ts.net:8399 page')
printf '%s' "$page" | grep -q '"status":200' || fail "the app on hub should open for laptop (me@example.com): $page"
fleet=$(on laptop 'cat ~/fleet/t3-fleet.toml')
printf '%s' "$fleet" | grep -q 'allow = \["me@example.com"\]' || fail "[ui] allow should name laptop's login: $fleet"
printf '%s' "$fleet" | grep -q '"relay"' || fail "[fleet] apply should have the relay: $fleet"
pass "B1: the relay runs on hub and answers through serve, laptop listens, the app on hub opens for me@example.com"

# ── desktop joins with the invite line, in a terminal ───────────────────
line=$(on laptop "node /opt/wizfe/driver.mjs $API invite desktop")
case "$line" in "curl -fsSL "*"| sh -s -- setup /srv/remote/fleet.git desktop") ;; *) fail "invite line: $line" ;; esac
if ! on desktop "python3 /opt/wizfe/ptyrun.py '$line'" >/tmp/$P-join.log 2>&1; then
  cat /tmp/$P-join.log
  fail "the invite line did not set desktop up"
fi
pass "desktop joined by running the invite line in a terminal"
on laptop 't3-fleet approve desktop' >/dev/null 2>&1 || true # nothing to approve when it brought nothing
# Each machine's timer, run now rather than waited for: laptop lets desktop read the secrets, desktop starts listening.
for _ in $(seq 6); do
  on laptop 'systemctl --user start t3-fleet-sync.service' || true
  on desktop 'systemctl --user start t3-fleet-sync.service' || true
  on desktop 'systemctl --user is-active --quiet t3-fleet-listen.service' && break
  sleep 5
done
on desktop 'systemctl --user is-active --quiet t3-fleet-listen.service' || fail "desktop's listener did not start"
pass "B1: desktop's own sync started its listener once it could read the secrets"

# ── a fix forwarded from the hub runs on desktop ────────────────────────
on laptop "cd ~/fleet && mkdir -p skills/demo && printf -- '---\nname: demo\ndescription: a demo skill\n---\nDemo.\n' > skills/demo/SKILL.md && git add skills && git commit -qm 'A skill' && git push -q"
job=$(on laptop 'node /tmp/hub-browser.mjs https://hub.tailnet.ts.net:8399 fix desktop skills') || fail "applying a fix from the hub failed: $job"
printf '%s' "$job" | grep -q '"state":"done"' || fail "the job should finish: $job"
printf '%s' "$job" | grep -q '"ok":true' || fail "the fix should succeed: $job"
on desktop '[ -L ~/.agents/skills/demo ]' || fail "desktop's listener should have linked demo: $job"
pass "a fix applied in the app on hub ran on desktop, by its own listener"

# ── B8: each alert is one push ──────────────────────────────────────────
last() { pushes | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).at(-1);console.log(r===undefined?"":r.title+" | "+r.body)})'; }
until_count() { for _ in $(seq 40); do [ "$(count)" -ge "$1" ] && return; sleep 2; done; }
sync_desktop() { on desktop 'systemctl --user start t3-fleet-sync.service' >/dev/null 2>&1 || true; }
sleep 40 # the relay re-reads git every 30 s: anything still owed would arrive now
before=$(pushes)
printf '%s' "$before" | grep -q 'alerts since last delivery' && fail "setup, joining or the relay's start pushed a summary: $before"
n0=$(count)
pass "B8: setting up, joining and starting the relay pushed no summary ($n0 pushes so far)"
# desktop loses its remote: a problem now, "failing" at the third sync in a row, each pushed once,
# though its state can only reach the relay (publishing to git fails).
on desktop 'git -C ~/fleet remote set-url origin /srv/remote/nowhere.git'
sync_desktop
until_count $((n0 + 1))
sync_desktop
sleep 40
[ "$(count)" -eq $((n0 + 1)) ] || fail "a problem should be one push, not $(($(count) - n0)): $(pushes)"
last | grep -q '^T3 Fleet: desktop needs attention | .*remote' || fail "the push should be desktop's problem: $(last)"
pass "B8: desktop's problem, one push, though the next sync still has it: $(last)"
sync_desktop
until_count $((n0 + 2))
sync_desktop
sleep 40
[ "$(count)" -eq $((n0 + 2)) ] || fail "failing three times should be one more push, not $(($(count) - n0 - 1)): $(pushes)"
last | grep -q 'sync failed 3 times in a row' || fail "the push should say sync failed 3 times: $(last)"
pass "B8: three failed syncs, one push: $(last)"
on desktop 'git -C ~/fleet remote set-url origin /srv/remote/fleet.git'
sync_desktop
until_count $((n0 + 3))
sync_desktop
sleep 40
[ "$(count)" -eq $((n0 + 3)) ] || fail "recovering should be one push, not $(($(count) - n0 - 2)): $(pushes)"
last | grep -q 'desktop' || fail "the push should be desktop's: $(last)"
last | grep -q ' 0 problems\|recovered' || fail "a recovery should raise no problem: $(last)"
pass "B8: the recovery, one push, with no new problem for the streak it ended: $(last)"
