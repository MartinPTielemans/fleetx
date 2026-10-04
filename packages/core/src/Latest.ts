/**
 * What "up to date" means right now: the newest agent CLIs on npm and the
 * newest T3 release on each channel. Looked up once per run by the
 * controller, never by the machines themselves.
 *
 * Every lookup degrades to "unknown" instead of failing: being offline must
 * not stop T3 Fleet from reporting what it can see.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { exec } from "./Exec.ts";
import {
  cliReleaseChannelOf,
  cliReleaseIndexPageUrl,
  type CliReleaseChannel,
} from "./vendor/t3/cliRelease.ts";

export const AGENT_PACKAGES = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
} as const;

export interface T3Channel {
  /** Newest first. */
  readonly versions: ReadonlyArray<string>;
}

export interface Latest {
  readonly agents: { readonly claude: string | null; readonly codex: string | null };
  readonly t3: Partial<Record<CliReleaseChannel, T3Channel>>;
}

const NpmLatest = Schema.Struct({ version: Schema.String });
const Releases = Schema.Array(Schema.Struct({ tag_name: Schema.String, draft: Schema.optional(Schema.Boolean) }));

const getText = (url: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client.execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers))).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((r) => r.text),
      Effect.timeout(Duration.seconds(15)),
      Effect.option,
    );
  });

const npmLatest = (pkg: string) =>
  Effect.gen(function* () {
    const text = yield* getText(`https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`);
    if (Option.isNone(text)) return null;
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(NpmLatest))(text.value).pipe(Effect.option);
    return Option.getOrNull(Option.map(decoded, (d) => d.version));
  });

/** GitHub allows 60 anonymous requests an hour; use gh's token when there is one. */
const githubToken = Effect.gen(function* () {
  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv) return fromEnv;
  const gh = yield* exec({ command: "gh", args: ["auth", "token"], timeout: Duration.seconds(5) });
  return gh.code === 0 ? gh.stdout.trim() : "";
});

/** Release versions per channel, newest first, from the first pages of the index. */
const t3Releases = (channels: ReadonlyArray<CliReleaseChannel>) =>
  Effect.gen(function* () {
    const result: Partial<Record<CliReleaseChannel, Array<string>>> = {};
    if (channels.length === 0) return result;
    const token = yield* githubToken;
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    for (let page = 1; page <= 3; page += 1) {
      const text = yield* getText(cliReleaseIndexPageUrl(page), headers);
      if (Option.isNone(text)) break;
      const releases = yield* Schema.decodeEffect(Schema.fromJsonString(Releases))(text.value).pipe(Effect.option);
      if (Option.isNone(releases) || releases.value.length === 0) break;
      for (const release of releases.value) {
        if (release.draft) continue;
        const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
        if (version === undefined) continue;
        (result[cliReleaseChannelOf(version)] ??= []).push(version);
      }
      if (channels.every((c) => (result[c]?.length ?? 0) > 0)) break;
    }
    return result;
  });

export const lookupLatest = (t3Versions: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const channels = [...new Set(t3Versions.map(cliReleaseChannelOf))];
    const [claude, codex, releases] = yield* Effect.all(
      [npmLatest(AGENT_PACKAGES.claude), npmLatest(AGENT_PACKAGES.codex), t3Releases(channels)],
      { concurrency: "unbounded" },
    );
    const t3: Partial<Record<CliReleaseChannel, T3Channel>> = {};
    for (const [channel, versions] of Object.entries(releases)) {
      t3[channel as CliReleaseChannel] = { versions };
    }
    return { agents: { claude, codex }, t3 } satisfies Latest;
  });

/** How far `version` trails its channel: 0 when newest, null when unknown. */
export const releasesBehind = (latest: Latest, version: string): { readonly behind: number | null; readonly newest: string | null } => {
  const channel = latest.t3[cliReleaseChannelOf(version)];
  if (channel === undefined || channel.versions.length === 0) return { behind: null, newest: null };
  const index = channel.versions.indexOf(version);
  return { behind: index === -1 ? null : index, newest: channel.versions[0] ?? null };
};

export type LatestRequirements = HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner;
