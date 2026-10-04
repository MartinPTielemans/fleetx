import { describe, expect, it } from "vite-plus/test";

import {
  fromClaude,
  fromCodex,
  looksLikeToken,
  secretNamer,
  secretRefs,
  shapeOf,
  type ExtractContext,
} from "./Credentials.ts";

const HOME = "/home/u";
const ctx = (env: Record<string, string> = {}, taken: Array<string> = []): ExtractContext => ({
  home: HOME,
  env,
  name: secretNamer(taken),
});
// Made-up values, shaped like the real thing.
const PAT = "ghp_abcdefghijklmnop0123456789";
const RANDOM = "q8Zr2mV7xK1pL4nB9cT3wY6s";

describe("fromClaude", () => {
  it("moves a bearer header into a secret and keeps other headers", () => {
    const got = fromClaude(
      "posthog",
      {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: `Bearer ${PAT}`, "X-Region": "eu" },
      },
      ctx(),
    );
    expect(got?.definition).toEqual({
      kind: "direct",
      url: "https://mcp.example.com/mcp",
      auth: { type: "bearer", token_env: "POSTHOG_TOKEN" },
      headers: { "X-Region": "eu" },
    });
    expect(got?.secrets).toEqual([
      { name: "POSTHOG_TOKEN", value: PAT, where: "header Authorization" },
    ]);
    expect(got?.local).toBeNull();
  });

  it("labels sse servers and marks localhost ones as this machine's", () => {
    const got = fromClaude("events", { type: "sse", url: "http://localhost:8123/sse" }, ctx());
    expect(got?.definition).toEqual({
      kind: "direct",
      url: "http://localhost:8123/sse",
      transport: "sse",
    });
    expect(got?.local).toContain("localhost");
  });

  it("moves credentials out of query parameters", () => {
    const got = fromClaude(
      "search",
      { type: "http", url: `https://search.example.com/mcp?apiKey=${RANDOM}&region=eu` },
      ctx(),
    );
    expect(got?.definition["url"]).toBe(
      "https://search.example.com/mcp?apiKey=$SEARCH_APIKEY&region=eu",
    );
    expect(got?.secrets.map((s) => s.value)).toEqual([RANDOM]);
  });

  it("keeps env, moving only credentials, and passwords in connection strings", () => {
    const got = fromClaude(
      "db",
      {
        command: `${HOME}/bin/db-mcp`,
        args: ["--connection", "postgres://app:hunter2@db.internal:5432/app", "--verbose"],
        env: {
          DB_PASSWORD: "hunter2",
          LOG_LEVEL: "debug",
          API_TOKEN: "short",
          DATABASE_URL: "postgres://app:other@db.internal/app",
        },
      },
      ctx(),
    );
    expect(got?.definition).toEqual({
      kind: "stdio",
      command: "~/bin/db-mcp",
      args: ["--connection", "postgres://app:$DB_PASSWORD@db.internal:5432/app", "--verbose"],
      // In env a secret is the whole value: `$NAME` and nothing else.
      env: {
        DB_PASSWORD: "$DB_PASSWORD",
        LOG_LEVEL: "debug",
        API_TOKEN: "$DB_API_TOKEN",
        DATABASE_URL: "$DB_DATABASE_URL",
      },
    });
    // One value, one secret.
    expect(got?.secrets.map((s) => s.name)).toEqual([
      "DB_PASSWORD",
      "DB_API_TOKEN",
      "DB_DATABASE_URL",
    ]);
  });

  it("moves the argument after --api-key, --token=… and KEY=value", () => {
    const got = fromClaude(
      "ctx7",
      {
        command: "npx",
        args: ["-y", "ctx7-mcp", "--api-key", RANDOM, `--token=${PAT}`, "-e", "SECRET_KEY=abc"],
      },
      ctx(),
    );
    expect(got?.definition["args"]).toEqual([
      "-y",
      "ctx7-mcp",
      "--api-key",
      "$CTX7_API_KEY",
      "--token=$CTX7_TOKEN",
      "-e",
      "SECRET_KEY=$CTX7_SECRET_KEY",
    ]);
    expect(got?.secrets).toHaveLength(3);
  });

  it("marks commands outside the home directory as this machine's", () => {
    expect(fromClaude("x", { command: "/opt/x/bin/x" }, ctx())?.local).toContain("/opt/x/bin/x");
    expect(fromClaude("x", { command: "npx", args: ["x"] }, ctx())?.local).toBeNull();
  });
});

describe("fromCodex", () => {
  it("takes a bearer token from the environment when it is set", () => {
    const got = fromCodex(
      "linear",
      { url: "https://mcp.linear.app/mcp", bearer_token_env_var: "LINEAR_KEY" },
      ctx({ LINEAR_KEY: RANDOM }),
    );
    expect(got?.definition).toEqual({
      kind: "direct",
      url: "https://mcp.linear.app/mcp",
      auth: { type: "bearer", token_env: "LINEAR_KEY" },
    });
    expect(got?.secrets).toEqual([
      { name: "LINEAR_KEY", value: RANDOM, where: expect.any(String) },
    ]);
    expect(got?.missing).toEqual([]);
  });

  it("marks it missing when it is not set, rather than an empty bearer", () => {
    const got = fromCodex(
      "linear",
      { url: "https://mcp.linear.app/mcp", bearer_token_env_var: "LINEAR_KEY" },
      ctx(),
    );
    expect(got?.secrets).toEqual([]);
    expect(got?.missing.map((m) => m.name)).toEqual(["LINEAR_KEY"]);
    expect(got?.definition["auth"]).toEqual({ type: "bearer", token_env: "LINEAR_KEY" });
  });

  it("keeps env and static headers, and names what it cannot carry", () => {
    const got = fromCodex(
      "gh",
      {
        command: "gh-mcp",
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: PAT },
        startup_timeout_sec: 20,
      },
      ctx(),
    );
    expect(got?.definition["env"]).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: "$GH_GITHUB_PERSONAL_ACCESS_TOKEN",
    });
    expect(got?.dropped).toEqual(["startup_timeout_sec"]);
  });
});

describe("secret names", () => {
  it("never collide with taken names or each other", () => {
    const name = secretNamer(["SERVER_TOKEN"]);
    expect(name("SERVER_TOKEN", "a")).toBe("SERVER_TOKEN_2");
    expect(name("SERVER_TOKEN", "b")).toBe("SERVER_TOKEN_3");
    expect(name("other", "a")).toBe("SERVER_TOKEN_2");
    expect(name("3d", null)).toBe("_3D");
  });

  it("tells tokens from ordinary values", () => {
    expect(looksLikeToken(PAT)).toBe(true);
    expect(looksLikeToken(RANDOM)).toBe(true);
    expect(looksLikeToken("debug")).toBe(false);
    expect(looksLikeToken("/usr/local/bin/something-long-1234")).toBe(false);
    expect(looksLikeToken("$ALREADY_A_REFERENCE_123456")).toBe(false);
  });
});

describe("shapeOf", () => {
  it("compares definitions without their secret names, old auth or new headers", () => {
    const old = { kind: "direct", url: "https://x", auth: { type: "bearer", token_env: "A" } };
    const now = { url: "https://x", kind: "direct", headers: { Authorization: "Bearer $B" } };
    expect(shapeOf(old)).toBe(shapeOf(now));
    expect(shapeOf(now)).not.toBe(shapeOf({ ...now, url: "https://y" }));
    expect(secretRefs(now)).toEqual(["B"]);
    expect(secretRefs(old)).toEqual(["A"]);
  });
});
