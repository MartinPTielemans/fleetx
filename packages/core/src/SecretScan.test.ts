import { describe, expect, it } from "vite-plus/test";

import { addedLines, lineHash, refusal, scanLine, scanText } from "./SecretScan.ts";

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
    ])
      expect([line, scanLine(line)]).toEqual([line, null]);
  });

  it("never scans an age-armored file", () => {
    const armored = `-----BEGIN AGE ENCRYPTED FILE-----\n${token("ghp_")}\n-----END AGE ENCRYPTED FILE-----\n`;
    expect(scanText("secrets/secrets.env.age", armored)).toEqual([]);
    expect(scanText("notes.txt", armored)).toEqual([]);
  });

  it("lets an allowed line through, by file and line hash", () => {
    const text = `a\nkey = "${token("", 32)}"\n`;
    const [hit] = scanText("skills/x/README.md", text);
    expect(hit).toMatchObject({ file: "skills/x/README.md", line: 2 });
    if (hit === undefined) return;
    expect(hit.hash).toBe(lineHash(`key = "${token("", 32)}"`));
    expect(
      scanText("skills/x/README.md", text, [{ file: "skills/x/README.md", line: hit.hash }]),
    ).toEqual([]);
    // The same line in another file is not allowed by it.
    expect(
      scanText("skills/y/README.md", text, [{ file: "skills/x/README.md", line: hit.hash }]),
    ).toHaveLength(1);
  });

  it("names the file, line and kind, never the value", () => {
    const value = token("ghp_");
    const hits = scanText("mcp/github.json", `{\n  "token": "${value}"\n}\n`);
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
