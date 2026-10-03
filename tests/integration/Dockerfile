# A throwaway fleet node: Node 24, git, an ssh server, and a user.
FROM node:24-bookworm-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends openssh-server openssh-client git ca-certificates procps hostname >/dev/null \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash dev && mkdir -p /home/dev/.ssh && chown dev:dev /home/dev/.ssh
CMD ["/usr/sbin/sshd", "-D", "-e"]
