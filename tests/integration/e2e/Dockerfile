# A node with systemd and a lingering user session, as a real server or desktop
# has (after /var/tmp/rc090's Dockerfile): T3 Fleet installs its sync timer,
# relay and listener as systemd user services here, unchanged.
FROM node:24-bookworm
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server openssh-client git ca-certificates procps hostname systemd systemd-sysv dbus dbus-user-session python3 openssl >/dev/null \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd && useradd -m -s /bin/bash dev \
 && systemctl enable ssh && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/dev
CMD ["/sbin/init"]
