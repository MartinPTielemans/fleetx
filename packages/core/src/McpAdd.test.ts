import { describe, expect, it } from "vite-plus/test";

import {
  isCredential,
  mcpDefinition,
  secretName,
  withMcpServer,
} from "../../../apps/cli/src/fleet.ts";

describe("withMcpServer", () => {
  it("appends to an existing list, or adds the table", () => {
    expect(
      withMcpServer(
        'roles = ["member"]\n\n[mcp]\n"servers.add" = ["a"]\n\n[codex]\nplugins = []\n',
        "b",
      ),
    ).toBe('roles = ["member"]\n\n[mcp]\n"servers.add" = ["a", "b"]\n\n[codex]\nplugins = []\n');
    expect(withMcpServer('[mcp]\nservers = ["a"]\n', "b")).toBe('[mcp]\nservers = ["a", "b"]\n');
    expect(withMcpServer('roles = ["member"]\n', "b")).toBe(
      'roles = ["member"]\n\n[mcp]\n"servers.add" = ["b"]\n',
    );
  });
});

describe("mcp add: credentials", () => {
  const base = {
    name: "github",
    url: undefined,
    command: "github-mcp",
    args: ["stdio"],
    tokenEnv: undefined,
    env: [],
    headers: [],
    literal: [],
    sse: false,
    secrets: {},
  };

  it("keeps a value in the secrets unless it is harmless or named with --literal", () => {
    expect(
      mcpDefinition({
        ...base,
        env: [
          "GITHUB_PERSONAL_ACCESS_TOKEN=ghp_abc",
          "GITHUB_TOOLSETS=repos,issues",
          "GITHUB_HOST=https://github.example.com",
          "READ_ONLY=true",
          "REVISION=4f3c2a1b9e",
        ],
        literal: ["revision"],
      }),
    ).toEqual({
      definition: {
        kind: "stdio",
        command: "github-mcp",
        args: ["stdio"],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: "$GITHUB_PERSONAL_ACCESS_TOKEN",
          GITHUB_TOOLSETS: "$GITHUB_TOOLSETS",
          GITHUB_HOST: "https://github.example.com",
          READ_ONLY: "true",
          REVISION: "4f3c2a1b9e",
        },
      },
      store: [
        { name: "GITHUB_PERSONAL_ACCESS_TOKEN", value: "ghp_abc" },
        { name: "GITHUB_TOOLSETS", value: "repos,issues" },
      ],
      refs: [],
    });
    expect(mcpDefinition({ ...base, literal: ["NOPE"] })).toEqual({
      problem: "--literal NOPE names no --env or --header",
    });
  });

  it("takes headers and SSE for a URL, and leaves $NAME references alone", () => {
    expect(
      mcpDefinition({
        ...base,
        name: "context7",
        command: undefined,
        url: "https://mcp.context7.com/sse",
        headers: ["X-Api-Key: k-1", "CONTEXT7_TEAM: $SHARED_TEAM", "Authorization: Basic dTpw"],
        sse: true,
      }),
    ).toEqual({
      definition: {
        kind: "direct",
        url: "https://mcp.context7.com/sse",
        transport: "sse",
        headers: {
          "X-Api-Key": "$CONTEXT7_X_API_KEY",
          CONTEXT7_TEAM: "$SHARED_TEAM",
          Authorization: "$CONTEXT7_AUTHORIZATION",
        },
      },
      store: [
        { name: "CONTEXT7_X_API_KEY", value: "k-1" },
        { name: "CONTEXT7_AUTHORIZATION", value: "Basic dTpw" },
      ],
      refs: ["SHARED_TEAM"],
    });
  });

  it("numbers a name another value already holds, and reuses one holding the same", () => {
    expect(secretName("github", "TOKEN", "new", { GITHUB_TOKEN: "old" })).toBe("GITHUB_TOKEN_2");
    expect(secretName("github", "TOKEN", "old", { GITHUB_TOKEN: "old" })).toBe("GITHUB_TOKEN");
    expect(secretName("9x", "api-key", "v", {})).toBe("MCP_9X_API_KEY");
  });

  it("counts every value as a credential but a number, boolean, path or URL without one", () => {
    for (const [name, value] of [
      ["apiKey", "12345"],
      ["X-Client", "Basic dTpw"],
      ["MODE", "ghp_0123456789abcdef"],
      ["TEAM", "acme"],
      ["DATABASE", "postgres://u:pw@db/x"],
      ["ENDPOINT", "https://x/mcp?apiKey=abc"],
    ] as const)
      expect(isCredential(name, value)).toBe(true);
    for (const [name, value] of [
      ["PATH", "/usr/bin"],
      ["PORT", "8080"],
      ["DEBUG", "false"],
      ["CONFIG", "~/config.json"],
      ["ENDPOINT", "https://x/mcp?page=2"],
    ] as const)
      expect(isCredential(name, value)).toBe(false);
  });

  it("refuses flags that do not fit the server", () => {
    expect(mcpDefinition({ ...base, headers: ["A: b"] })).toEqual({
      problem: "--header and --sse are for --url servers",
    });
    expect(
      mcpDefinition({ ...base, command: undefined, url: "https://x", env: ["A=b"] }),
    ).toMatchObject({ problem: expect.stringContaining("--env is for --command") });
    expect(mcpDefinition({ ...base, env: ["not a pair"] })).toMatchObject({
      problem: expect.stringContaining("not KEY=VALUE"),
    });
  });
});
