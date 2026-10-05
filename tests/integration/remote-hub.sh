#!/usr/bin/env bash
# Throwaway SSH hub: read-only probe, failed join, resume, and completed rerun.
# Uses the existing integration Dockerfile. Never connects to a configured real host.
set -euo pipefail
cd "$(dirname "$0")/../.."
root=$PWD
scratch=$(mktemp -d /var/tmp/wizrem-hub.XXXXXX)
name="wizrem-hub-$$"
image="wizrem-node-$$"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$scratch"
}
trap cleanup EXIT
pnpm --filter t3-fleet build
ssh-keygen -q -t ed25519 -N '' -f "$scratch/key"
docker build -q -t "$image" -f tests/integration/Dockerfile tests/integration
docker run -d --name "$name" --hostname box -p 127.0.0.1::22 "$image" >/dev/null
docker cp "$scratch/key.pub" "$name:/home/dev/.ssh/authorized_keys"
docker cp apps/cli/dist/bin.mjs "$name:/tmp/wizrem-build.mjs"
docker exec "$name" bash -c 'chown -R dev:dev /home/dev/.ssh; chmod 700 /home/dev/.ssh; chmod 600 /home/dev/.ssh/authorized_keys; mkdir -p /srv/remote /home/dev/authority; chown -R dev:dev /srv/remote /home/dev/authority; passwd -d dev >/dev/null'
docker exec -u dev "$name" bash -c 'git init -q --bare -b main /srv/remote/fleet.git && HOME=/home/dev/authority node /tmp/wizrem-build.mjs setup --dir /home/dev/authority/fleet --remote /srv/remote/fleet.git --yes' > "$scratch/authority.txt"
port=$(docker port "$name" 22/tcp | cut -d: -f2)
cat > "$scratch/config" <<CONFIG
Host wizrem-hub
  HostName 127.0.0.1
  Port $port
  User dev
  IdentityFile $scratch/key
  IdentitiesOnly yes
  IdentityAgent none
  UserKnownHostsFile $scratch/known_hosts
  GlobalKnownHostsFile /dev/null
CONFIG
# Trust the key read directly from our new container, rather than ssh-keyscan's network answer.
printf '[127.0.0.1]:%s ' "$port" > "$scratch/known_hosts"
docker exec "$name" cat /etc/ssh/ssh_host_ed25519_key.pub >> "$scratch/known_hosts"
cat > "$scratch/ssh" <<'SH'
#!/bin/sh
exec /usr/bin/ssh -F "$WIZREM_SSH_CONFIG" "$@"
SH
chmod 755 "$scratch/ssh"
export WIZREM_SSH_CONFIG="$scratch/config"
export WIZREM_CONTAINER="$name"
export PATH="$scratch:$PATH"
node "$root/tests/integration/remote-hub.mjs"
