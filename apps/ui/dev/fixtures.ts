/**
 * A made-up fleet for `T3_FLEET_UI_FIXTURES=1 vp dev`: three machines, a few
 * findings, a proposal, skills, a hub with servers and calls, model proxy traffic.
 * Typed against Api.ts so it stays in step with the real server. Writes
 * succeed and change nothing.
 */
import type {
  HubCall,
  HubServer,
  ModelProxyStats,
  ModelWindow,
  UiFixPlan,
  UiJob,
  UiJobKind,
  UiModels,
  UiProposal,
  UiSession,
  UiSkills,
  UiSkillsPreview,
  UiStatus,
} from "@t3-fleet/core/Api";

import { followSetup, setupJobs, setupResponse, setupSession } from "./setup-fixtures.ts";

export { followSetup };

const now = Date.now();
const min = 60_000;

const window = (requests: number, failed = 0, fallbacks = 0): ModelWindow => ({
  requests,
  retried: Math.round(requests * 0.02),
  failed,
  failures: failed > 0 ? { "529": failed } : {},
  fallbacks,
  ttfbP50Ms: 640,
  ttfbP95Ms: 2380,
});

const stats = (busy: number, failed = 0): ModelProxyStats => ({
  at: now,
  startedAt: now - 26 * 60 * min,
  version: "0.4.0",
  egress: "direct",
  upstreams: [
    {
      upstream: "anthropic",
      m5: window(busy),
      h1: window(busy * 11, failed),
      h24: window(busy * 180, failed * 3),
      lastError:
        failed > 0 ? { at: now - 14 * min, class: "529", message: "overloaded_error" } : null,
    },
    { upstream: "openai", m5: window(1), h1: window(9), h24: window(140), lastError: null },
  ],
});

const session: UiSession = {
  version: "0.4.0",
  self: "laptop",
  authority: true,
  nodes: ["laptop", "server", "desktop"],
  relay: "https://server.tailnet.ts.net",
};

const status: UiStatus = {
  checkedAt: now - 20_000,
  elapsedMs: 3200,
  summary: "T3 Fleet  3 environments  2 warnings  (3.2s)",
  environments: [
    {
      name: "laptop",
      roles: ["authority"],
      reachable: true,
      platform: "darwin arm64",
      t3: { version: "0.0.46-nightly.20261003.2623", channel: "nightly", behind: 0 },
      agents: [
        { name: "claude", version: "2.1.288", latest: "2.1.288" },
        { name: "codex", version: "0.160.0", latest: "0.160.0" },
      ],
      providers: [
        {
          instanceId: "claudeAgent",
          label: "claude",
          enabled: true,
          startsInT3: true,
          version: "2.1.288",
          runs: "~/.local/bin/t3-fleet-claude",
          viaModels: true,
        },
        {
          instanceId: "codex",
          label: "codex",
          enabled: true,
          startsInT3: true,
          version: "0.160.0",
          runs: "~/.local/bin/codex",
          viaModels: false,
        },
      ],
      sync: { at: now - 2 * min, result: "ok", streak: 0, message: "converged" },
      providerAuth: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          auth: "authenticated",
          method: "setup-token",
          label: null,
          status: "ready",
          detail: "",
          checkedAt: now - 30_000,
          source: "t3",
        },
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          auth: "authenticated",
          method: "chatgpt",
          label: "ChatGPT Pro",
          status: "ready",
          detail: "",
          checkedAt: now - 30_000,
          source: "t3",
        },
      ],
      models: stats(4),
    },
    {
      name: "server",
      roles: ["relay", "member"],
      reachable: true,
      platform: "linux x64",
      t3: { version: "0.0.43-nightly.20260927.2344", channel: "nightly", behind: 23 },
      agents: [
        { name: "claude", version: "2.1.288", latest: "2.1.288" },
        { name: "codex", version: "0.159.0", latest: "0.160.0" },
      ],
      providers: [
        {
          instanceId: "claudeAgent",
          label: "claude",
          enabled: true,
          startsInT3: true,
          version: "2.1.288",
          runs: "~/.local/bin/t3-fleet-claude",
          viaModels: true,
        },
        {
          instanceId: "codex",
          label: "codex",
          enabled: true,
          startsInT3: true,
          version: "0.159.0",
          runs: "~/.local/bin/codex",
          viaModels: false,
        },
      ],
      sync: { at: now - 7 * min, result: "ok", streak: 0, message: "converged" },
      providerAuth: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          auth: "unauthenticated",
          method: "claude.ai",
          label: null,
          status: "error",
          detail: "Not logged in",
          checkedAt: now - 30_000,
          source: "t3",
        },
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          auth: "authenticated",
          method: "chatgpt",
          label: null,
          status: "ready",
          detail: "",
          checkedAt: now - 30_000,
          source: "t3",
        },
      ],
      models: stats(2, 7),
    },
    {
      name: "desktop",
      roles: ["member"],
      reachable: false,
      error: "ssh desktop failed: connect to host desktop port 22: Operation timed out",
      platform: null,
      t3: { version: null, channel: null, behind: null },
      agents: [],
      providers: [],
      sync: {
        at: now - 4 * 60 * min,
        result: "fail",
        streak: 3,
        message: "pull failed: could not resolve host",
      },
      providerAuth: [],
      models: null,
    },
  ],
  findings: [
    {
      id: "desktop:unreachable",
      node: "desktop",
      severity: "error",
      area: "reach",
      title: "unreachable over ssh",
      detail: "connect to host desktop port 22: Operation timed out",
    },
    {
      id: "server:t3-behind",
      node: "server",
      severity: "warn",
      area: "t3",
      title: "T3 is 23 nightly releases behind (0.0.43 nightly 09-27 → 0.0.46 nightly 10-03)",
      fix: {
        command:
          "~/.t3/runtime/versions/0.0.43-nightly.20260927.2344/t3 update --channel nightly --yes",
        safe: false,
        disrupts: "restarts the T3 server on server; threads running there stop",
      },
    },
    {
      id: "server:codex-behind",
      node: "server",
      severity: "warn",
      area: "agents",
      title: "codex 0.159.0 is behind 0.160.0",
      fix: { command: "npm i -g @openai/codex@0.160.0", safe: true },
    },
    {
      id: "server:models-failing",
      node: "server",
      severity: "warn",
      area: "models",
      title: "6.4% of Anthropic requests failed in the last hour (529)",
    },
    {
      id: "server:skills-unlinked",
      node: "server",
      severity: "warn",
      area: "skills",
      title: "1 skill is not linked into place: tdd",
      fix: {
        command: "mkdir -p ~/.claude/skills && ln -sfn ~/.agents/skills/tdd ~/.claude/skills/tdd",
        safe: true,
      },
    },
    {
      id: "laptop:skill-stray-scratchpad",
      node: "laptop",
      severity: "warn",
      area: "skills",
      title: "skill scratchpad was installed in ~/.codex/skills outside T3 Fleet",
      detail:
        "proposing it puts it in the repo for an authority to approve; the original is moved aside, not deleted",
      fix: { command: "t3-fleet skills adopt scratchpad --from ~/.codex/skills", safe: true },
    },
    {
      id: "desktop:t3-behind",
      node: "desktop",
      severity: "info",
      area: "t3",
      title: "T3 is 1 nightly release behind (0.0.46 nightly 10-02 → 0.0.46 nightly 10-03)",
      fix: {
        command: "t3 update --channel nightly --yes",
        safe: false,
        disrupts: "restarts the T3 server on desktop; threads running there stop",
      },
    },
    {
      id: "laptop:claude-other-copies",
      node: "laptop",
      severity: "info",
      area: "agents",
      title: "another claude on PATH",
      accepted: "the distribution ships its own package",
    },
  ],
};

const proposals: ReadonlyArray<UiProposal> = [
  {
    node: "server",
    branch: "t3-fleet/staging/server",
    commit: "5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e",
    change: "c".repeat(64),
    summary: "1 file changed, 4 insertions(+), 1 deletion(-)",
    files: ["skills/review/SKILL.md"],
    diff: "diff --git a/skills/review/SKILL.md b/skills/review/SKILL.md\nindex 1a2b3c4..5d6e7f8 100644\n--- a/skills/review/SKILL.md\n+++ b/skills/review/SKILL.md\n@@ -1,6 +1,9 @@\n ---\n name: review\n-description: Review a diff.\n+description: Review a diff against the repo's standards.\n ---\n \n Read the change first.\n+\n+Then check it against AGENTS.md\n+and the originating issue.\n",
    autoApprovable: true,
  },
];

const link = (home: string, skill: string, client = true) => [
  { skill, dir: `${home}/.agents/skills`, state: "ok" as const },
  ...(client ? [{ skill, dir: `${home}/.claude/skills`, state: "ok" as const }] : []),
];

const skills: UiSkills = {
  skills: [
    {
      name: "code-review",
      description: "Review the changes since a fixed point along standards and spec.",
      source: { name: "skills", url: "https://github.com/acme/skills.git" },
    },
    { name: "drafts", description: null, source: null },
    { name: "review", description: "Review a diff against the repo's standards.", source: null },
    {
      name: "tdd",
      description: "Test-driven development: red, green, refactor.",
      source: { name: "skills", url: "https://github.com/acme/skills.git" },
    },
  ],
  nodes: [
    {
      node: "laptop",
      at: now - 20_000,
      store: "/Users/u/.agents/skills",
      links: ["code-review", "drafts", "review", "tdd"].flatMap((s) => link("/Users/u", s)),
      strays: [{ skill: "scratchpad", dir: "/Users/u/.codex/skills" }],
      dangling: [],
      ignored: [],
    },
    {
      node: "server",
      at: now - 20_000,
      store: "/home/u/.agents/skills",
      links: [
        ...link("/home/u", "code-review"),
        ...link("/home/u", "review"),
        ...link("/home/u", "tdd", false),
        { skill: "tdd", dir: "/home/u/.claude/skills", state: "missing" },
      ],
      strays: [],
      dangling: [],
      ignored: ["drafts"],
    },
    { node: "desktop", at: null, store: null, links: [], strays: [], dangling: [], ignored: [] },
  ],
};

const skillsPreview: UiSkillsPreview = {
  files: ["skills/tdd"],
  stat: " skills/tdd/SKILL.md | 4 +++-\n 1 file changed, 3 insertions(+), 1 deletion(-)",
  diff: "diff --git a/skills/tdd/SKILL.md b/skills/tdd/SKILL.md\n--- a/skills/tdd/SKILL.md\n+++ b/skills/tdd/SKILL.md\n@@ -1,5 +1,7 @@\n ---\n name: tdd\n-description: Test-driven development.\n+description: Test-driven development: red, green, refactor.\n ---\n+\n+Write the failing test first.\n",
  digest: "fixture",
  skipped: ["skills/remotion"],
};

const hubServers: ReadonlyArray<HubServer> = [
  {
    name: "linear",
    kind: "remote",
    upstream: "https://mcp.linear.app/mcp",
    state: "running",
    detail: null,
    auth: "oauth",
    expiresAt: now + 50 * min,
    tools: 23,
    lastCheckAt: now - 40_000,
  },
  {
    name: "notion",
    kind: "remote",
    upstream: "https://mcp.notion.com/mcp",
    state: "needs-login",
    detail: "refresh token was revoked",
    auth: "oauth",
    expiresAt: null,
    tools: null,
    lastCheckAt: now - 40_000,
  },
  {
    name: "playwright",
    kind: "container",
    upstream: "mcr.microsoft.com/playwright/mcp",
    state: "running",
    detail: null,
    auth: "none",
    expiresAt: null,
    tools: 21,
    lastCheckAt: now - 40_000,
  },
  {
    name: "postgres",
    kind: "hosted-stdio",
    upstream: "npx -y @modelcontextprotocol/server-postgres",
    state: "error",
    detail: "exited with code 1: connection refused",
    auth: "bearer",
    expiresAt: null,
    tools: null,
    lastCheckAt: now - 40_000,
  },
];

const hubCalls: ReadonlyArray<HubCall> = Array.from({ length: 14 }, (_, i) => ({
  at: now - i * 3 * min,
  server: ["linear", "playwright", "linear", "notion"][i % 4] ?? "linear",
  client: i % 3 === 0 ? "relay" : "laptop-claude",
  method: i % 5 === 0 ? "tools/list" : "tools/call",
  tool:
    i % 5 === 0
      ? null
      : (["list_issues", "browser_navigate", "create_issue", "search"][i % 4] ?? null),
  durationMs: 120 + ((i * 97) % 900),
  outcome: i % 4 === 3 ? "unauthorized" : i === 6 ? "error" : "ok",
  error: i % 4 === 3 ? "needs login" : i === 6 ? "timeout after 30s" : null,
}));

const models: UiModels = {
  nodes: status.environments.map((e) => ({
    node: e.name,
    at: e.reachable ? now - 20_000 : null,
    providerAuth: e.providerAuth,
    stats: e.models,
  })),
};

const json = (value: unknown) => ({ status: 200, body: JSON.stringify(value) });

/** Every fix in the fixtures, planned as the server would. */
const plan: UiFixPlan = {
  fixes: status.findings.flatMap((f) =>
    f.fix === undefined
      ? []
      : [{ id: f.id, node: f.node, title: f.title, ...f.fix, digest: `fixture-${f.id}` }],
  ),
  notApplicable: [],
};

/** A job that is already over: fixtures change nothing. */
const job = (
  kind: UiJobKind,
  title: string,
  result: Partial<Pick<UiJob, "applied" | "landed">> = {},
): UiJob => ({
  id: `fixture-${kind}`,
  kind,
  title,
  state: "done",
  step: null,
  startedAt: Date.now(),
  finishedAt: Date.now(),
  error: null,
  applied: null,
  landed: null,
  ...result,
});

/** What the event stream sends first: where things stand. */
export const fixtureEvents = `: connected\n\nevent: check\ndata: ${JSON.stringify(status)}\n\n`;

/**
 * The answer to one request. `page` is the query string of the page asking
 * (its Referer): ?setup=… makes this machine one setup has not finished on;
 * see setup-fixtures.ts.
 */
export const fixtureResponse = (
  method: string,
  path: string,
  body = "",
  page = new URLSearchParams(),
): { status: number; body: string; delay?: number } | "events" => {
  if (path === "/api/events") return "events";
  const setup = setupResponse(method, path, body, page);
  if (setup !== null) return setup;
  if (method === "POST") {
    if (path === "/api/session") return json({ token: "fixture" });
    if (path === "/api/fixes/plan") {
      const ids: ReadonlyArray<string> =
        body === "" ? [] : (JSON.parse(body) as { ids: ReadonlyArray<string> }).ids;
      return json({ fixes: plan.fixes.filter((f) => ids.includes(f.id)), notApplicable: [] });
    }
    if (path === "/api/fixes")
      return json(
        job("fixes", "Apply fixes", {
          applied: { results: [], notApplied: [{ id: "*", reason: "fixtures change nothing" }] },
        }),
      );
    if (path.endsWith("/approve")) return json(job("approve", "Approve server's proposal"));
    if (path.endsWith("/reject")) return json(job("reject", "Reject server's proposal"));
    if (path.endsWith("/login")) return json({ url: "https://example.com/oauth/authorize" });
    if (path === "/api/skills/lookup")
      return json({
        url: "https://github.com/acme/skills.git",
        skills: [
          { name: "code-review", exists: true },
          { name: "grilling", exists: false },
          { name: "tdd", exists: true },
        ],
      });
    if (path === "/api/skills/preview") return json(skillsPreview);
    if (path.startsWith("/api/skills/")) {
      const kind =
        path === "/api/skills/add"
          ? "skills-add"
          : path === "/api/skills/update"
            ? "skills-update"
            : "skills-remove";
      return json(
        job(kind, "Change skills", {
          landed: { paths: ["skills/tdd"], landed: "fixtures change nothing" },
        }),
      );
    }
    return { status: 204, body: "" };
  }
  switch (path) {
    case "/api/session":
      return json(setupSession(page, session) ?? session);
    case "/api/jobs":
      return json(setupJobs(page));
    case "/api/status":
      return json(status);
    case "/api/proposals":
      return json(proposals);
    case "/api/alerts":
      return json([
        {
          at: now - 4 * 60 * min,
          node: "desktop",
          kind: "failing",
          message: "sync failed 3 times in a row: pull failed",
        },
        {
          at: now - 26 * 60 * min,
          node: "server",
          kind: "resolved",
          message: "codex starts in T3 again",
        },
        {
          at: now - 27 * 60 * min,
          node: "server",
          kind: "problem",
          message: "codex does not start in T3",
        },
      ]);
    case "/api/models":
      return json(models);
    case "/api/skills":
      return json(skills);
    case "/api/hub/servers":
      return json(hubServers);
    case "/api/hub/calls":
      return json(hubCalls);
  }
  if (path.startsWith("/api/config/")) {
    return json([
      { path: "agents.claude.channel", value: '"latest"', source: "defaults" },
      { path: "mcp.servers", value: '["linear","playwright"]', source: "profile workstation" },
      { path: "skills.ignore", value: '["experimental"]', source: "node laptop (add)" },
      { path: "models.providers", value: '["claudeAgent","codex"]', source: "defaults" },
    ]);
  }
  return { status: 404, body: "no such endpoint" };
};
