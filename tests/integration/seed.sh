#!/usr/bin/env bash
# What a machine has before it meets T3 Fleet: skills in all three places, a
# git-cloned skill repository, a plugin's skill, MCP servers with credentials
# in headers, env, query strings, args and a connection string, an sse and a
# localhost server, a project-scoped server, and instruction files.
# Usage (as the user, in its home): seed.sh laptop|desktop
# Every credential value contains "SEKRIT", so a test can look for any of them.
set -euo pipefail
role=$1
skill() { mkdir -p "$1" && printf -- '---\nname: %s\ndescription: %s\n---\n%s\n' "$(basename "$1")" "$2" "$3" > "$1/SKILL.md"; }

if [ "$role" = laptop ]; then
  skill ~/.agents/skills/demo "a demo" "same everywhere"
  # Codex's own copy of the same skill: one skill, and Codex must not see it twice.
  skill ~/.codex/skills/demo "a demo" "same everywhere"
  skill ~/.codex/skills/.system/builtin "Codex's own" "never touched"
  skill ~/.claude/skills/review "reviews" "the laptop's review"
  # A clone holding two skills in subfolders.
  if [ ! -d /srv/remote/toolbox.git ]; then
    rm -rf /tmp/toolbox && mkdir -p /tmp/toolbox && git -C /tmp/toolbox init -q
    skill /tmp/toolbox/skills/fmt "formats" "fmt v1"
    skill /tmp/toolbox/skills/lint "lints" "lint v1"
    git -C /tmp/toolbox add -A && git -C /tmp/toolbox commit -qm v1 && git clone -q --bare /tmp/toolbox /srv/remote/toolbox.git
  fi
  git clone -q /srv/remote/toolbox.git ~/.claude/skills/toolbox
  # A plugin's skill: Claude's plugin system owns it.
  skill ~/.claude/plugins/cache/acme/skills/plug "a plugin's" "plugin"
  ln -s ~/.claude/plugins/cache/acme/skills/plug ~/.claude/skills/plug
  printf '# Laptop rules\nBe brief.\n' > ~/.claude/CLAUDE.md
  mkdir -p ~/.codex && printf '# Codex rules\n' > ~/.codex/AGENTS.md
  cat > ~/.claude.json <<'JSON'
{
  "numStartups": 3,
  "mcpServers": {
    "posthog": { "type": "http", "url": "https://mcp.posthog.example/mcp",
                 "headers": { "Authorization": "Bearer phx_SEKRIT_header_0001", "X-Region": "eu" } },
    "search": { "type": "http", "url": "https://search.example/mcp?apiKey=SEKRIT_query_0002&region=eu" },
    "ctx": { "command": "npx", "args": ["-y", "ctx-mcp", "--api-key", "SEKRIT_arg_0003"],
             "env": { "API_TOKEN": "SEKRIT_env_0004", "LOG_LEVEL": "debug" } },
    "events": { "type": "sse", "url": "https://events.example/sse" },
    "localdb": { "type": "http", "url": "http://localhost:7777/mcp" }
  },
  "projects": {
    "/home/dev/code/app": { "mcpServers": {
      "db": { "command": "db-mcp", "args": ["postgres://app:SEKRIT_conn_0005@db.internal/app"] } } }
  }
}
JSON
  cat > ~/.codex/config.toml <<'TOML'
model = "gpt-5"

[mcp_servers.linear]
url = "https://mcp.linear.example/mcp"
bearer_token_env_var = "LINEAR_KEY"

[mcp_servers.ctx]
command = "npx"
args = ["-y", "ctx-mcp", "--api-key", "SEKRIT_arg_0003"]
env = { API_TOKEN = "SEKRIT_env_0004", LOG_LEVEL = "debug" }
TOML
fi

if [ "$role" = desktop ]; then
  # The same skill, newer here: a clash with the laptop's.
  skill ~/.claude/skills/review "reviews" "the desktop's newer review"
  skill ~/.agents/skills/desk "desktop only" "desk"
  printf '# Desktop rules\nBe thorough.\n' > ~/.claude/CLAUDE.md
  cat > ~/.claude.json <<'JSON'
{
  "mcpServers": {
    "posthog": { "type": "http", "url": "https://mcp.posthog.example/mcp",
                 "headers": { "Authorization": "Bearer phx_SEKRIT_desktop_0006", "X-Region": "eu" } },
    "notes": { "type": "http", "url": "https://notes.example/mcp",
               "headers": { "X-Api-Key": "SEKRIT_notes_0007" } }
  }
}
JSON
fi
