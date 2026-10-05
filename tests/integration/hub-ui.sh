#!/usr/bin/env bash
# The app hosted by the hub, end to end on throwaway containers.
#
# laptop is the authority, server the hub (the relay), desktop someone else on
# the tailnet. Real Tailscale does not run here, so serve-proxy.mjs stands in
# for `tailscale serve` on server: it forwards server's own address, port 8399,
# to the relay on 127.0.0.1:8399, drops Tailscale-* headers the client sent, and
# sets Tailscale-User-Login by source address (laptop = me@example.com, desktop
# = mallory@example.com). It runs as root, as tailscaled does: the relay lets
# in only connections made by root, or by the user an installed tailscaled
# runs as under systemd (HubUi.ts); not by a user who names a program
# tailscaled. The relay URL is plain http on a ts.net name in /etc/hosts; real
# serve adds TLS.
# Services run by hand (no systemd here).
#
# Shown: the gate (allowed login, unknown login, a client's own identity header
# replaced, a program on the hub posing as tailscale serve refused, also from
# 127.0.0.2 on the ports of root's connection lingering in TIME_WAIT), a fix
# applied from the hub and run by laptop's listener, a fix request from a
# member holding the relay token refused by the relay, approving refused on the hub.
# Usage: tests/integration/hub-ui.sh   (needs Docker; builds the bundle first)
set -euo pipefail
cd "$(dirname "$0")"
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-wizhub-it}
pass() { printf '\033[32mpass\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; exit 1; }
on() { local node=$1; shift; docker compose exec -T -u dev "$node" bash -lc "export PATH=\$HOME/.local/bin:\$PATH; $*"; }
logs() { on server 'tail -n 30 /tmp/relay.log' || true; on laptop 'tail -n 30 /tmp/listen.log' || true; }

trap 'docker compose down -v -t 1 >/dev/null 2>&1' EXIT
(cd ../.. && pnpm --filter t3-fleet build >/dev/null)
docker compose up -d --build --quiet-pull >/dev/null 2>&1

ip() { docker compose exec -T "$1" hostname -i | awk '{print $1}'; }
SERVER=$(ip server) LAPTOP=$(ip laptop) DESKTOP=$(ip desktop)
HUB=http://server.tailnet.ts.net:8399
for n in laptop server desktop; do
  # Copied rather than mounted: a checkout outside Docker's shared folders mounts empty.
  docker compose cp ../../apps/cli/dist/bin.mjs "$n:/opt/t3-fleet.mjs" >/dev/null 2>&1
  docker compose exec -T "$n" bash -c "
    echo '$SERVER server.tailnet.ts.net' >> /etc/hosts
    mkdir -p /home/dev/.local/bin && chmod 755 /opt/t3-fleet.mjs && ln -sf /opt/t3-fleet.mjs /home/dev/.local/bin/t3-fleet && chown -R dev:dev /home/dev/.local
    chown dev:dev /srv/remote"
  on "$n" 'git config --global user.name dev && git config --global user.email dev@example.com && git config --global init.defaultBranch main'
  docker compose cp hub-browser.mjs "$n:/tmp/hub-browser.mjs" >/dev/null 2>&1
done
docker compose cp serve-proxy.mjs server:/tmp/serve-proxy.mjs >/dev/null 2>&1

# A fleet: laptop the authority, server the relay.
on laptop 'git init -q --bare /srv/remote/fleet.git'
on laptop 't3-fleet setup --yes --remote /srv/remote/fleet.git' >/dev/null || fail "setup on laptop"
on server 't3-fleet setup /srv/remote/fleet.git server --yes --relay' >/dev/null || fail "setup on server"
on laptop 't3-fleet sync' >/dev/null || true
on laptop 't3-fleet approve server' >/dev/null || fail "approving server: $(on laptop 't3-fleet review' 2>&1)"
for n in server laptop server; do on "$n" 't3-fleet sync' >/dev/null || true; done
# The relay's address, the app's one login, and no fixes applied by sync, so one waits for the hub.
on laptop "cd ~/fleet && node -e '
  const fs = require(\"fs\"); let t = fs.readFileSync(\"t3-fleet.toml\", \"utf8\");
  t = t.replace(/^\\[relay\\][^\\[]*/m, \"\");
  t = t.replace(/^apply = .*\\n/m, \"\");
  t += \"\\n[relay]\\nurl = \\\"$HUB\\\"\\nport = 8399\\n\\n[ui]\\nallow = [\\\"me@example.com\\\"]\\n\";
  t = /^\\[fleet\\]/m.test(t) ? t.replace(/^\\[fleet\\]\\n/m, \"[fleet]\\napply = []\\n\") : t + \"\\n[fleet]\\napply = []\\n\";
  fs.writeFileSync(\"t3-fleet.toml\", t);'
  mkdir -p skills/demo && printf -- '---\nname: demo\ndescription: a demo skill\n---\nDemo.\n' > skills/demo/SKILL.md
  git add -A && git commit -qm 'The relay on the tailnet, the app for me, a skill' && git push -q"
for n in server laptop; do on "$n" 't3-fleet sync' >/dev/null || true; done
on server 'grep -q "^T3_FLEET_RELAY_TOKEN=" ~/.config/t3-fleet/secrets.env' || fail "server cannot read the relay token"
pass "a fleet with server as its hub, [ui] allow = me@example.com"

docker compose exec -d -u dev server bash -lc 'export PATH=$HOME/.local/bin:$PATH; t3-fleet relay serve > /tmp/relay.log 2>&1'
docker compose exec -d -u root server bash -lc "node /tmp/serve-proxy.mjs $SERVER $LAPTOP=me@example.com,$DESKTOP=mallory@example.com > /tmp/proxy.log 2>&1"
docker compose exec -d -u dev laptop bash -lc 'export PATH=$HOME/.local/bin:$PATH; t3-fleet listen > /tmp/listen.log 2>&1'
for i in $(seq 30); do on laptop "node -e 'fetch(\"$HUB/health\").then(r=>process.exit(r.ok?0:1),()=>process.exit(1))'" && break; sleep 1; done
on laptop 't3-fleet sync' >/dev/null || true   # reports to the relay, findings with their fixes

# The gate.
page=$(on laptop "node /tmp/hub-browser.mjs $HUB page")
printf '%s' "$page" | grep -q '"status":200' || { logs; fail "laptop (me@example.com) should get the app: $page"; }
page=$(on desktop "node /tmp/hub-browser.mjs $HUB page")
printf '%s' "$page" | grep -q '"status":403' || fail "desktop (mallory) should be refused: $page"
printf '%s' "$page" | grep -q 'mallory@example.com' || fail "the refusal should name the login it saw: $page"
printf '%s' "$page" | grep -q '\[ui\]' || fail "the refusal should say how to add it: $page"
spoof=$(on desktop "node -e 'fetch(\"$HUB/\",{headers:{\"tailscale-user-login\":\"me@example.com\"}}).then(r=>console.log(r.status))'")
[ "$spoof" = 403 ] || fail "a client's own Tailscale-User-Login must not get it in: $spoof"
on server "node -e 'require(\"net\").connect(8399,\"$SERVER\").on(\"connect\",()=>process.exit(0))'" || fail "the proxy should listen on server's address"
sess=$(on desktop "node /tmp/hub-browser.mjs $HUB session")
printf '%s' "$sess" | grep -q '"status":403' || fail "mallory should get no session: $sess"
# A program on the hub itself, as the relay's own user, connecting to the loopback port with the headers serve sets.
onhub=$(on server "node -e '
  const r = require(\"http\").request({ host: \"127.0.0.1\", port: 8399, method: \"POST\", path: \"/api/session\",
    headers: { host: \"server.tailnet.ts.net:8399\", \"tailscale-user-login\": \"me@example.com\", \"x-t3-fleet-hub\": \"1\" } },
    (a) => { let b = \"\"; a.on(\"data\", (d) => (b += d)).on(\"end\", () => console.log(a.statusCode, b)); });
  r.end();'")
printf '%s' "$onhub" | grep -q '^403 ' || fail "a program on the hub must not mint a session as me@example.com: $onhub"
# The same, with dev running a program it named tailscaled: a name anyone can give is not tailscaled.
docker compose exec -d -u dev server bash -c 'cp /bin/sleep /tmp/tailscaled && exec /tmp/tailscaled 600'
on server 'for i in $(seq 50); do pgrep -x tailscaled >/dev/null && exit 0; sleep 0.1; done; exit 1' || fail "the fake tailscaled did not start"
spoofed=$(on server "node -e '
  const r = require(\"http\").request({ host: \"127.0.0.1\", port: 8399, method: \"POST\", path: \"/api/session\",
    headers: { host: \"server.tailnet.ts.net:8399\", \"tailscale-user-login\": \"me@example.com\", \"x-t3-fleet-hub\": \"1\" } },
    (a) => { let b = \"\"; a.on(\"data\", (d) => (b += d)).on(\"end\", () => console.log(a.statusCode, b)); });
  r.end();'")
printf '%s' "$spoofed" | grep -q '^403 ' || fail "a user's program named tailscaled must not make its user tailscaled's: $spoofed"
on server 'pkill -x tailscaled' || true
# Root's earlier connection from 127.0.0.1:41777 lingers in TIME_WAIT, which /proc lists as root's; dev
# asks from 127.0.0.2:41777, the same two ports: the kernel's table says the asking socket is dev's.
docker compose exec -T -u root server node -e '
  const s = require("net").connect({ host: "127.0.0.1", port: 8399, localPort: 41777 });
  s.on("connect", () => s.end()).on("close", () => process.exit(0));' || fail "root's connection to the relay"
on server 'grep -q "0100007F:A331 0100007F:20CF 06" /proc/net/tcp' || fail "root's closed connection should linger in TIME_WAIT"
lingering=$(on server "node -e '
  const r = require(\"http\").request({ host: \"127.0.0.1\", port: 8399, localAddress: \"127.0.0.2\", localPort: 41777, method: \"POST\", path: \"/api/session\",
    headers: { host: \"server.tailnet.ts.net:8399\", \"tailscale-user-login\": \"me@example.com\", \"x-t3-fleet-hub\": \"1\" } },
    (a) => { let b = \"\"; a.on(\"data\", (d) => (b += d)).on(\"end\", () => console.log(a.statusCode, b)); });
  r.end();'")
printf '%s' "$lingering" | grep -q '^403 ' || fail "root's connection in TIME_WAIT must not vouch for dev's on 127.0.0.2 with the same ports: $lingering"
pass "the gate: me@example.com gets the app, mallory gets a page naming that login and [ui] allow, a forged header is replaced, a program on the hub posing as serve is refused, also when its user runs a program named tailscaled, and when root's closed connection on the same ports lingers"

# A member holding the relay token asks the relay itself to run a fix laptop does propose, with its
# real id and digest and its interruption "acknowledged": no one reviewed it in the app, so nothing runs.
forged=$(on laptop "TOKEN=\$(sed -n 's/^T3_FLEET_RELAY_TOKEN=//p' ~/.config/t3-fleet/secrets.env | tr -d '\"') node /tmp/hub-browser.mjs $HUB forge laptop skills") || { logs; fail "forging a request: $forged"; }
printf '%s' "$forged" | grep -q '"status":40[0-9]' || { logs; fail "the relay must refuse a fix request from the relay token: $forged"; }
sleep 5
on laptop '[ ! -e ~/.agents/skills/demo ]' || { logs; fail "laptop ran a fix no one approved in the app: $forged"; }
on laptop '! grep -q "the hub asks for" /tmp/listen.log' || fail "laptop's listener should have been asked nothing"
pass "a member with the relay token asking the relay for a fix is refused ($(printf '%s' "$forged" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).status))')), and nothing runs"

# A fix applied from the hub, run by laptop's listener.
on laptop '[ ! -e ~/.agents/skills/demo ]' || fail "demo should not be linked on laptop yet (apply = [])"
job=$(on laptop "node /tmp/hub-browser.mjs $HUB fix laptop skills") || { logs; fail "applying from the hub failed"; }
printf '%s' "$job" | grep -q '"state":"done"' || { logs; fail "the job should finish: $job"; }
printf '%s' "$job" | grep -q '"ok":true' || { logs; fail "the fix should succeed: $job"; }
on laptop '[ -L ~/.agents/skills/demo ]' || { logs; fail "laptop's listener should have linked demo: $job"; }
on laptop 'grep -q "the hub asks for" /tmp/listen.log' || fail "laptop's listener should say it answered the hub"
pass "a fix applied in the app on the hub ran on laptop, by its own listener: $(printf '%s' "$job" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).finding))')"

approve=$(on laptop "node /tmp/hub-browser.mjs $HUB approve server")
printf '%s' "$approve" | grep -q '"status":403' || fail "approving on the hub should be refused: $approve"
printf '%s' "$approve" | grep -q 'on an authority (laptop)' || fail "it should say where: $approve"
pass "approving a proposal in the app on the hub is refused: on an authority (laptop)"
