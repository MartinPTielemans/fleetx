import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { addedLines, lineHash, refusal, scanLine, scanText } from "./SecretScan.ts";

const scan = (...args: Parameters<typeof scanText>) => Effect.runPromise(scanText(...args));

// Built at run time so this file holds nothing a scanner would flag.
const token = (prefix: string, n = 36) =>
  prefix + "aZ3kQ9mX7pL2vB8nR4tY6wC1eF5gH0jK9sD2fG7hJ4kL1zX8cV3bN6mQ".slice(0, n);

describe("what looks like a secret", () => {
  it("knows tokens by their prefix", () => {
    expect(scanLine(`GITHUB_TOKEN=${token("ghp_")}`)).toBe("a GitHub token");
    expect(scanLine(`"x": "${token("github_pat_", 50)}"`)).toBe("a GitHub token");
    expect(scanLine(token("sk-ant-api03-", 40))).toBe("an Anthropic API key");
    expect(scanLine(`key ${token("sk-proj-", 40)}`)).toBe("an API key (sk-…)");
    expect(scanLine(token("xoxb-123456-", 24))).toBe("a Slack token");
    expect(scanLine(token("lin_api_", 30))).toBe("a Linear API key");
    expect(scanLine("AKIA" + "Q3XZ7K2M9P4L8R6T")).toBe("an AWS access key");
    expect(scanLine(token("glpat-", 20))).toBe("a GitLab token");
    expect(scanLine(token("npm_", 36))).toBe("an npm token");
    expect(scanLine("-----BEGIN OPENSSH PRIVATE KEY-----")).toBe("a private key");
  });

  it("finds a token in a URL query, in a URL's password and in a flag", () => {
    expect(
      scanLine(`"url": "https://mcp.exa.ai/mcp?exaApiKey=3f9a1c2e-7b4d-4e8a-9c1f-2d6b8e0a4c7f"`),
    ).toBe("a token in a URL query (exaApiKey)");
    expect(scanLine("postgres://app:Xk92mQ7pLz3vR8@db.internal/app")).toBe("a password in a URL");
    expect(scanLine(`"args": ["-y", "server", "--api-key", "${token("", 32)}"]`)).toBe(
      "a secret in a command-line flag (--api-key)",
    );
    expect(scanLine(`--token=${token("", 32)}`)).toBe("a secret in a command-line flag (--token)");
    expect(scanLine(`OPENWEATHER_API_KEY = "${token("", 32)}"`)).toBe(
      "a secret assigned to OPENWEATHER_API_KEY",
    );
  });

  it("finds bearer tokens, JWTs, webhooks and the other shapes MCP configs carry", () => {
    const b64 = (json: string) =>
      btoa(json).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    const jwt = [
      b64('{"alg":"HS256","typ":"JWT"}'),
      b64('{"sub":"1234567890","n":"x"}'),
      token("", 30),
    ];
    for (const [line, kind] of [
      [`"Authorization": "Bearer ${token("", 32)}"`, "a bearer token"],
      [
        `"args": ["mcp-remote", "--header", "Authorization: Bearer ${token("", 32)}"]`,
        "a bearer token",
      ],
      [`"token": "${jwt.join(".")}"`, "a JWT"],
      [
        ["https://hooks.slack", "com/services/T0123ABCD/B0456EFGH", token("", 24)]
          .join(".")
          .replace(".com/services/T0123ABCD/B0456EFGH.", ".com/services/T0123ABCD/B0456EFGH/"),
        "a Slack webhook",
      ],
      [
        ["https://discord.com/api/webhooks/123456789012345678", token("", 40)].join("/"),
        "a Discord webhook",
      ],
      [`REDIS_URL=redis://:${token("", 20)}@cache:6379`, "a password in a URL"],
      [`https://api.example.com/v1?auth=${token("", 24)}`, "a token in a URL query (auth)"],
      [
        `https://storage.example.com/blob?sv=2024&sig=${token("", 24)}`,
        "a token in a URL query (sig)",
      ],
      [`AUTH=${token("", 24)}`, "a secret assigned to AUTH"],
      [`SERVICE_BEARER=${token("", 24)}`, "a secret assigned to SERVICE_BEARER"],
      [`machine api.example.com login me password ${token("", 20)}`, "a password in a .netrc line"],
      [`password ${token("", 20)}`, "a password in a .netrc line"],
      [
        `SENTRY_DSN=https://${"a1b2c3d4".repeat(4)}:${"e5f6a7b8".repeat(4)}@sentry.io/42`,
        "a password in a URL",
      ],
    ])
      expect([line, scanLine(line ?? "")]).toEqual([line, kind]);
  });

  it("finds passwords with punctuation, shorter keys' shapes and Basic auth", () => {
    for (const [line, kind] of [
      ["DB_PASSWORD=Sup3r!Secret#2024xyzw", "a secret assigned to DB_PASSWORD"],
      ['password: "Xq7v@R2mK9pLs4TnB8w1"', "a secret assigned to password"],
      ["admin_pwd = 'p@55w0rd!Kz9q'", "a secret assigned to admin_pwd"],
      ["--db-password=Xq7v!R2mK9pL", "a secret in a command-line flag (--db-password)"],
      ["machine db.example.com login app password Xq7v!R2mK9", "a password in a .netrc line"],
      [`SENDGRID=${["SG", token("", 22), token("", 43)].join(".")}`, "a SendGrid API key"],
      [
        `SENDGRID=${["SG", "aBcDeFgHiJkLmNoPqRsTuV", token("", 43)].join(".")}`,
        "a SendGrid API key",
      ],
      [`TELEGRAM=${"1234567890"}:${token("AA", 33)}`, "a Telegram bot token"],
      [`"Authorization": "Basic ${btoa("deploy:Xq7v!R2mK9pL")}"`, "a Basic auth header"],
    ])
      expect([line, scanLine(line ?? "")]).toEqual([line, kind]);
  });

  it("refuses a merge conflict marker", async () => {
    const [hit] = await scan("skills/SOURCES.json", "{\n<<<<<<< Updated upstream\n}\n");
    expect(hit).toMatchObject({ line: 2, kind: "a merge conflict marker" });
  });

  it("skips references, placeholders and examples", () => {
    for (const line of [
      'url = "https://mcp.exa.ai/mcp?exaApiKey=${EXA_API_KEY}"',
      '"args": ["--api-key", "$LINEAR_API_KEY"]',
      'MAPBOX_API_KEY = "YOUR_MAPBOX_ACCESS_TOKEN"',
      'API_KEY = "your-api-key-here"',
      "GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      'OPENAI_API_KEY="sk-..."',
      "token: <your token>",
      "Authorization: Bearer $TOKEN",
      "max_tokens = 4096",
      "password: example-password-1234",
      "SECRET_KEY = process.env.SECRET_KEY",
      "https://user:${PASSWORD}@example.com",
      "mapboxgl.accessToken = 'pk.eyJ1IjoiZXhhbXBsZSIsImEiOiJjbGV4YW1wbGUifQ.example';",
      // A publishable key, shaped like Mapbox's: varied, but meant to be shown.
      `mapboxgl.accessToken = '${["pk", token("eyJ1Ijoi", 40), token("", 22)].join(".")}';`,
      "age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p",
      `posthog.init('${"phc_" + token("", 40)}', { api_host: 'https://us.i.posthog.com' })`,
      // A modern Sentry DSN carries only its public key.
      `SENTRY_DSN=https://${"a1b2c3d4".repeat(4)}@o450000.ingest.sentry.io/5500000`,
      // -k is curl's --insecure, not a key.
      `curl -k -H "Accept: application/json" https://api.example.com/v1/items/${token("", 24)}`,
    ])
      expect([line, scanLine(line)]).toEqual([line, null]);
  });

  it("leaves ordinary code, paths and variable names alone", () => {
    // Shaped like lines in a real config repo and in T3 Fleet's own output.
    for (const line of [
      '  "token_env": "T3_FLEET_MCP_TOKEN_MAC"',
      '"auth": { "type": "bearer", "token_env": "MCP_SERVER_123_TOKEN" }',
      "\tsigningkey = ~/.ssh/id_ed25519.pub",
      "api_key = secrets.token_urlsafe(48)",
      "const key = fam[2].trim().toLowerCase()",
      "ffprobe -v error -show_entries format=duration -of default=nokey=1:noprint_wrappers=1 in.mp4",
      'outputKey: "renders/out-1.mp4"',
      "keyframeInterval = 30",
      '      key: "t3-fleet-git-config-missing",',
      `CLAUDE_CODE_OAUTH_TOKEN="sk-ant-oat01-abc"`,
      "const bulletKey = `${section.id}-${index}-${item.slug}`",
      'subject_token_type = "urn:ietf:params:oauth:token-type:access_token"',
      "client_secret = config.oauth.clientSecret2",
      "token = settings.oauth2AccessToken",
      "apiKey = env.S3SecretAccessKey",
      "signingKey: Schema.Uint8ArrayFromBase64,",
      "readonly encryptionKey: Schema.Uint8ArrayFromBase64,",
      "export PWD=build-output-v2",
      "OLDPWD=/srv/releases/2024-06-01/app",
      "DB_PASSWORD = process.env.DB_PASSWORD",
      'password: "YOUR_PASSWORD_HERE_123"',
      "const password = getPassword(user.id, 42)",
      "password = os.environ['DB_PASSWORD']",
      "Basic authentication is supported for 2 endpoints",
      `"Authorization": "Basic ${btoa("ab")}"`,
      "--token-env T3_FLEET_MCP_TOKEN_LAPTOP",
      "Bearer tokens expire after 3600 seconds",
    ])
      expect([line, scanLine(line)]).toEqual([line, null]);
  });

  it("skips only an age file or the fleet's secrets, not a file that mentions the armor", async () => {
    const armored = `-----BEGIN AGE ENCRYPTED FILE-----\n${token("ghp_")}\n-----END AGE ENCRYPTED FILE-----\n`;
    expect(await scan("secrets/secrets.env.age", armored)).toEqual([]);
    expect(await scan("backup/old.age", armored)).toEqual([]);
    expect(await scan("secrets/anything.txt", `${token("ghp_")}\n`)).toEqual([]);
    expect(await scan("notes.md", `How age armor looks:\n${armored}`)).toHaveLength(1);
  });

  it("lets an allowed line through, by file and the line's SHA-256", async () => {
    const text = `a\nkey = "${token("", 32)}"\n`;
    const [hit] = await scan("skills/x/README.md", text);
    expect(hit).toMatchObject({ file: "skills/x/README.md", line: 2 });
    if (hit === undefined) return;
    expect(hit.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hit.hash).toBe(await Effect.runPromise(lineHash(`key = "${token("", 32)}"`)));
    expect(
      await scan("skills/x/README.md", text, [{ file: "skills/x/README.md", line: hit.hash }]),
    ).toEqual([]);
    // The same line in another file is not allowed by it.
    expect(
      await scan("skills/y/README.md", text, [{ file: "skills/x/README.md", line: hit.hash }]),
    ).toHaveLength(1);
  });

  it("names the file, line and kind, never the value", async () => {
    const value = token("ghp_");
    const hits = await scan("mcp/github.json", `{\n  "token": "${value}"\n}\n`);
    const message = refusal(hits);
    expect(message).toContain("mcp/github.json:2 looks like a GitHub token");
    expect(message).toContain(`t3-fleet secrets allow mcp/github.json ${hits[0]?.hash}`);
    expect(message).not.toContain(value);
  });
});

describe("a diff's added lines", () => {
  it("numbers them in the new file", () => {
    const diff = [
      "diff --git a/mcp/exa.json b/mcp/exa.json",
      "--- a/mcp/exa.json",
      "+++ b/mcp/exa.json",
      "@@ -2,0 +3,2 @@",
      '+  "url": "x",',
      '+  "y": 1',
      "diff --git a/gone.txt b/gone.txt",
      "--- a/gone.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
    ].join("\n");
    expect([...addedLines(diff)]).toEqual([
      [
        "mcp/exa.json",
        [
          { line: 3, text: '  "url": "x",' },
          { line: 4, text: '  "y": 1' },
        ],
      ],
    ]);
  });
});
