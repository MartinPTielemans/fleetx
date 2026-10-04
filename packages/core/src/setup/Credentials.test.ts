import { describe, expect, it } from "vite-plus/test";

import {
  fromClaude,
  fromCodex,
  isSecretValue,
  looksLikeToken,
  nameFor,
  residue,
  secretNamer,
  secretRefs,
  shapeOf,
  type ExtractContext,
  type Extracted,
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
const SK = "sk-live-9fJ2kL4mN6pQ8rS0tU2vW4x";

/** Every secret's value is gone from the definition, and nothing is left alone for it. */
const clean = (got: Extracted | null) => {
  expect(got).not.toBeNull();
  const text = JSON.stringify(got?.definition);
  for (const s of got?.secrets ?? []) {
    expect(text).not.toContain(s.value);
    expect(text).not.toContain(encodeURIComponent(s.value));
  }
  expect(got?.leave).toBeNull();
  return got as Extracted;
};

describe("fromClaude", () => {
  it("moves a bearer header into auth and keeps other headers", () => {
    const got = clean(
      fromClaude(
        "posthog",
        {
          type: "http",
          url: "https://mcp.example.com/mcp",
          headers: { Authorization: `Bearer ${PAT}`, "X-Region": "eu" },
        },
        ctx(),
      ),
    );
    expect(got.definition).toEqual({
      kind: "direct",
      url: "https://mcp.example.com/mcp",
      auth: { type: "bearer", token_env: "POSTHOG_TOKEN" },
      headers: { "X-Region": "eu" },
    });
    expect(got.secrets).toEqual([
      { name: "POSTHOG_TOKEN", value: PAT, where: "header Authorization" },
    ]);
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

  it("rebuilds URLs from their parts: query, user, path and password, encoded or not", () => {
    const query = clean(
      fromClaude(
        "search",
        { type: "http", url: `https://s.example/mcp?api%5Fkey=abc+def${RANDOM}&region=eu` },
        ctx(),
      ),
    );
    expect(query.definition["url"]).toBe(
      "https://s.example/mcp?api%5Fkey=$SEARCH_API_KEY&region=eu",
    );
    expect(query.secrets[0]?.value).toBe(`abc def${RANDOM}`);
    const user = clean(
      fromClaude("gh", { type: "http", url: `https://${PAT}@host.example/mcp` }, ctx()),
    );
    expect(user.definition["url"]).toBe("https://$GH_TOKEN@host.example/mcp");
    const path = clean(
      fromClaude(
        "zap",
        { type: "http", url: `https://mcp.zapier.example/api/mcp/${SK}/sse` },
        ctx(),
      ),
    );
    expect(path.definition["url"]).toBe("https://mcp.zapier.example/api/mcp/$ZAP_PATH_TOKEN/sse");
    const odd = clean(
      fromClaude(
        "db",
        { command: "db", args: ["postgres://app:pa%5Ess%7Cw0rd@db.internal/app"] },
        ctx(),
      ),
    );
    expect(odd.definition["args"]).toEqual(["postgres://app:$DB_PASSWORD@db.internal/app"]);
    expect(odd.secrets[0]?.value).toBe("pa^ss|w0rd");
  });

  it("treats mcp-remote --header and -H values as headers", () => {
    const got = clean(
      fromClaude(
        "remote",
        {
          command: "npx",
          args: [
            "mcp-remote",
            "https://remote.example/mcp",
            "--header",
            `Authorization: Bearer ${SK}`,
            `--header=Authorization:Bearer ${PAT}`,
            "-H",
            `X-Api-Key: ${RANDOM}`,
            "--header",
            "X-Region: eu",
          ],
        },
        ctx(),
      ),
    );
    expect(got.definition["args"]).toEqual([
      "mcp-remote",
      "https://remote.example/mcp",
      "--header",
      "Authorization: Bearer $REMOTE_TOKEN",
      "--header=Authorization:Bearer $REMOTE_TOKEN_2",
      "-H",
      "X-Api-Key: $REMOTE_X_API_KEY",
      "--header",
      "X-Region: eu",
    ]);
  });

  it("keeps harmless env, and makes the whole value the secret otherwise", () => {
    const got = clean(
      fromClaude(
        "db",
        {
          command: `${HOME}/bin/db-mcp`,
          args: ["--connection", "postgres://app:hunter2@db.internal:5432/app", "--verbose"],
          env: {
            DB_PASSWORD: "hunter2",
            LOG_LEVEL: "debug",
            AUTH_ENABLED: "true",
            TOKENIZERS_PARALLELISM: "false",
            SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1",
            DATABASE_URL: "postgres://app:other@db.internal/app",
          },
        },
        ctx(),
      ),
    );
    expect(got.definition).toEqual({
      kind: "stdio",
      command: "~/bin/db-mcp",
      args: ["--connection", "postgres://app:$DB_PASSWORD@db.internal:5432/app", "--verbose"],
      env: {
        DB_PASSWORD: "$DB_PASSWORD",
        LOG_LEVEL: "debug",
        AUTH_ENABLED: "true",
        TOKENIZERS_PARALLELISM: "false",
        SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1",
        DATABASE_URL: "$DB_DATABASE_URL",
      },
    });
    expect(got.secrets.map((s) => s.name)).toEqual(["DB_PASSWORD", "DB_DATABASE_URL"]);
  });

  it("moves the argument after --api-key, --token=… and KEY=value", () => {
    const got = clean(
      fromClaude(
        "ctx7",
        {
          command: "npx",
          args: ["-y", "ctx7-mcp", "--api-key", RANDOM, `--token=${PAT}`, "-e", "SECRET_KEY=abc"],
        },
        ctx(),
      ),
    );
    expect(got.definition["args"]).toEqual([
      "-y",
      "ctx7-mcp",
      "--api-key",
      "$CTX7_API_KEY",
      "--token=$CTX7_TOKEN",
      "-e",
      "SECRET_KEY=$CTX7_SECRET_KEY",
    ]);
  });

  it("fills ${VAR} placeholders from the environment, or reports them missing", () => {
    const entry = {
      type: "http",
      url: "https://l.example/mcp",
      headers: { Authorization: "Bearer ${MY_TOKEN}" },
    };
    const set = clean(fromClaude("linear", entry, ctx({ MY_TOKEN: RANDOM })));
    expect(set.definition["auth"]).toEqual({ type: "bearer", token_env: "LINEAR_MY_TOKEN" });
    expect(set.secrets.map((s) => s.value)).toEqual([RANDOM]);
    expect(fromClaude("linear", entry, ctx())?.missing.map((m) => m.name)).toEqual([
      "LINEAR_MY_TOKEN",
    ]);
  });

  it("leaves alone an app's server, and one with a credential it cannot separate", () => {
    const app = "/Applications/ChatGPT.app/Contents/Resources/node_repl";
    expect(fromClaude("node_repl", { command: app }, ctx())?.leave).toContain("an app's own");
    const relative = "./Codex.app/Contents/MacOS/computer-use";
    expect(fromClaude("cu", { command: relative }, ctx())?.leave).toContain("an app's own");
    const glued = fromClaude("x", { command: "x", args: [`mode:glued${SK}`] }, ctx());
    expect(glued?.leave).toContain("could not be separated");
    const pem = fromClaude(
      "y",
      { command: "y", env: { PRIVATE_KEY: "-----BEGIN\nabc\n-----END" } },
      ctx(),
    );
    expect(pem?.leave).toContain("spans several lines");
  });

  it("marks your own binaries outside the home directory as this machine's", () => {
    expect(fromClaude("x", { command: "/opt/x/bin/x" }, ctx())?.local).toContain("/opt/x/bin/x");
    expect(fromClaude("x", { command: "npx", args: ["x"] }, ctx())?.local).toBeNull();
  });
});

describe("credentials in JSON, fragments and any credential flag", () => {
  it("replaces a key inside a JSON argument, a URL fragment, and --pass, -apikey values", () => {
    const got = clean(
      fromClaude(
        "x",
        {
          command: "x-mcp",
          args: [
            "--config",
            '{"apiKey":"hunter2","region":"eu","nested":{"token":"abc"}}',
            '--opts={"password":"pw1"}',
            "https://x.example/mcp#key=frag-secret&view=1",
            "--pass",
            "hunter3",
            "-apikey",
            "short",
            "--verbose",
            "true",
          ],
        },
        ctx(),
      ),
    );
    expect(got.definition["args"]).toEqual([
      "--config",
      '{"apiKey":"$X_API_KEY","region":"eu","nested":{"token":"$X_TOKEN"}}',
      '--opts={"password":"$X_PASSWORD"}',
      "https://x.example/mcp#key=$X_KEY&view=1",
      "--pass",
      "$X_PASS",
      "-apikey",
      "$X_APIKEY",
      "--verbose",
      "true",
    ]);
  });

  it("finds them in a definition even when nothing was extracted", () => {
    expect(residue({ args: ['{"apiKey":"hunter2"}'] }, [])).toContain("JSON");
    expect(residue({ url: "https://x.example/mcp#token=abc" }, [])).toContain("URL");
    expect(residue({ args: ["--pass", "hunter3"] }, [])).toContain("--pass");
    expect(residue({ args: ["--pass", "$X_PASS", '{"apiKey":"$X"}'] }, [])).toBeNull();
  });

  it("resolves mcp-remote's ${AUTH_HEADER} from the server's own env", () => {
    const got = clean(
      fromClaude(
        "remote",
        {
          command: "npx",
          args: ["mcp-remote", "https://r.example/mcp", "--header", "Authorization:${AUTH_HEADER}"],
          env: { AUTH_HEADER: `Bearer ${SK}` },
        },
        ctx(),
      ),
    );
    expect(got.missing).toEqual([]);
    expect(got.definition["env"]).toEqual({ AUTH_HEADER: "$REMOTE_AUTH_HEADER" });
    expect(got.definition["args"]).toEqual([
      "mcp-remote",
      "https://r.example/mcp",
      "--header",
      "Authorization:$REMOTE_AUTH_HEADER",
    ]);
  });
});

describe("fromCodex", () => {
  it("takes a bearer token from the environment, under the server's name", () => {
    const got = clean(
      fromCodex(
        "linear",
        { url: "https://mcp.linear.app/mcp", bearer_token_env_var: "GITHUB_TOKEN" },
        ctx({ GITHUB_TOKEN: RANDOM }),
      ),
    );
    expect(got.definition).toEqual({
      kind: "direct",
      url: "https://mcp.linear.app/mcp",
      auth: { type: "bearer", token_env: "LINEAR_GITHUB_TOKEN" },
    });
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

  it("keeps env, names what it cannot carry, and leaves disabled servers alone", () => {
    const got = fromCodex(
      "gh",
      { command: "gh-mcp", env: { GITHUB_PERSONAL_ACCESS_TOKEN: PAT }, startup_timeout_sec: 20 },
      ctx(),
    );
    expect(got?.definition["env"]).toEqual({
      GITHUB_PERSONAL_ACCESS_TOKEN: "$GH_GITHUB_PERSONAL_ACCESS_TOKEN",
    });
    expect(got?.dropped).toEqual(["startup_timeout_sec"]);
    expect(fromCodex("off", { command: "x", enabled: false }, ctx())?.leave).toBe(
      "disabled in Codex",
    );
  });
});

describe("secret names", () => {
  it("are the server's, never collide, and are never shared between servers", () => {
    const name = secretNamer(["SERVER_TOKEN"]);
    expect(name("server", "token", "a")).toBe("SERVER_TOKEN_2");
    expect(name("server", "token", "b")).toBe("SERVER_TOKEN_3");
    expect(name("server", "token", "a")).toBe("SERVER_TOKEN_2");
    expect(name("other", "token", "a")).toBe("OTHER_TOKEN");
  });

  it("never take a name that changes how programs run", () => {
    expect(nameFor("node", "options")).toBe("MCP_NODE_OPTIONS");
    expect(nameFor("path", "")).toBe("MCP_PATH");
    expect(nameFor("ld", "preload")).toBe("MCP_LD_PRELOAD");
  });

  it("tell credentials from ordinary values", () => {
    expect(looksLikeToken(PAT)).toBe(true);
    expect(looksLikeToken("3f2a1b6c-1d2e-4f5a-8b9c-0d1e2f3a4b5c")).toBe(false);
    expect(looksLikeToken("0123456789abcdef0123456789abcdef01234567")).toBe(false);
    expect(isSecretValue("LOG_LEVEL", "debug")).toBe(false);
    expect(isSecretValue("API_KEY", "hunter")).toBe(true);
    expect(isSecretValue("REGION", "eu-west-1a9")).toBe(true);
  });
});

describe("residue", () => {
  it("finds a secret's value in any encoding, and token-shaped leftovers", () => {
    const s = [{ name: "A", value: "a b+c", where: "x" }];
    expect(residue({ url: "https://h/?k=a%20b%2Bc" }, s)).toBe("x");
    expect(residue({ url: "https://h/?k=a+b%2Bc" }, s)).toBe("x");
    expect(residue({ args: [`x${SK}`] }, [])).toBe("something shaped like a token");
    expect(residue({ args: ["$LONG_SECRET_NAME_2024_ABCDEF"] }, [])).toBeNull();
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
