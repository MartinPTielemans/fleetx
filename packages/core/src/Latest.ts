/**
 * What "up to date" means right now: the newest agent CLIs on npm and the
 * newest T3 release on each channel. Looked up by the controller, never by
 * the machines themselves, and kept for a while (see getText).
 *
 * Every lookup degrades to "unknown" instead of failing: being offline must
 * not stop T3 Fleet from reporting what it can see.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { exec } from "./Exec.ts";
import { stateDir } from "./Names.ts";
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
  /** Why a lookup has no answer, so "unknown" is said rather than left out. */
  readonly failed?: { readonly claude?: string; readonly codex?: string; readonly t3?: string };
}

const NpmLatest = Schema.Struct({ version: Schema.String });
const Releases = Schema.Array(
  Schema.Struct({ tag_name: Schema.String, draft: Schema.optional(Schema.Boolean) }),
);

/**
 * Lookups are kept for 15 minutes in the state directory, then revalidated
 * with their ETag: an unchanged answer is a 304, which GitHub does not count
 * against its 60 anonymous requests an hour. A failed lookup falls back to
 * the last answer for a day; after that it is a failed lookup, so a machine
 * long offline does not look current.
 */
const FRESH_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;

const Cache = Schema.Record(
  Schema.String,
  Schema.Struct({ at: Schema.Number, etag: Schema.NullOr(Schema.String), body: Schema.String }),
);
/** The cache as read, changed in place by each lookup. */
type Cache = { changed: boolean; readonly entries: { [url: string]: (typeof Cache.Type)[string] } };

export const latestCachePath = (home: string) => `${stateDir(home)}/latest.json`;

/** The body, or why there is none. */
type Got = { readonly body: string } | { readonly error: string };

const getText = (
  cache: Cache,
  url: string,
  headers: Effect.Effect<Record<string, string>, never, LatestRequirements>,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const kept = cache.entries[url];
    if (kept !== undefined && now - kept.at < FRESH_MS) return { body: kept.body } satisfies Got;
    const client = yield* HttpClient.HttpClient;
    const sent = { ...(yield* headers), ...(kept?.etag ? { "If-None-Match": kept.etag } : {}) };
    const response = yield* client
      .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(sent)))
      .pipe(
        Effect.flatMap((r) =>
          r.status === 200
            ? r.text.pipe(
                Effect.map((body) => ({ status: 200, body, etag: r.headers["etag"] ?? null })),
              )
            : Effect.succeed({ status: r.status, body: "", etag: null }),
        ),
        Effect.timeout(Duration.seconds(15)),
        Effect.result,
      );
    if (response._tag === "Success" && response.success.status === 200) {
      cache.entries[url] = { at: now, etag: response.success.etag, body: response.success.body };
      cache.changed = true;
      return { body: response.success.body } satisfies Got;
    }
    if (response._tag === "Success" && response.success.status === 304 && kept !== undefined) {
      cache.entries[url] = { ...kept, at: now };
      cache.changed = true;
      return { body: kept.body } satisfies Got;
    }
    if (kept !== undefined && now - kept.at < STALE_MS) return { body: kept.body } satisfies Got;
    const status = response._tag === "Success" ? response.success.status : null;
    const reason =
      status === null
        ? `no answer from ${new URL(url).host}`
        : (status === 403 || status === 429) && url.startsWith("https://api.github.com/")
          ? "GitHub's limit of 60 anonymous requests an hour is used up; `gh auth login` or GITHUB_TOKEN raises it"
          : `${new URL(url).host} answered ${status}`;
    const days = kept === undefined ? 0 : Math.floor((now - kept.at) / STALE_MS);
    return {
      error:
        kept === undefined
          ? reason
          : `${reason}; the last answer is ${days} day${days === 1 ? "" : "s"} old`,
    } satisfies Got;
  });

const npmLatest = (cache: Cache, pkg: string) =>
  Effect.gen(function* () {
    const got = yield* getText(
      cache,
      `https://registry.npmjs.org/${pkg.replace("/", "%2f")}/latest`,
      Effect.succeed({}),
    );
    if ("error" in got) return { version: null, error: got.error };
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(NpmLatest))(got.body).pipe(
      Effect.option,
    );
    return Option.match(decoded, {
      onNone: () => ({ version: null, error: "npm's answer was not understood" }),
      onSome: (d) => ({ version: d.version, error: null }),
    });
  });

/** GitHub allows 60 anonymous requests an hour; use gh's token when there is one. */
const githubToken = Effect.gen(function* () {
  const fromEnv = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"];
  if (fromEnv) return fromEnv;
  const gh = yield* exec({ command: "gh", args: ["auth", "token"], timeout: Duration.seconds(5) });
  return gh.code === 0 ? gh.stdout.trim() : "";
});

/** Release versions per channel, newest first, from the first pages of the index; and why a page could not be read. */
const t3Releases = (cache: Cache, channels: ReadonlyArray<CliReleaseChannel>) =>
  Effect.gen(function* () {
    const result: Partial<Record<CliReleaseChannel, Array<string>>> = {};
    if (channels.length === 0) return { result, error: null };
    // Asked for only when a page has to come from GitHub, not from the cache.
    const headers = yield* Effect.cached(
      githubToken.pipe(
        Effect.map((token): Record<string, string> => ({
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        })),
      ),
    );
    for (let page = 1; page <= 3; page += 1) {
      const got = yield* getText(cache, cliReleaseIndexPageUrl(page), headers);
      if ("error" in got) return { result, error: got.error };
      const releases = yield* Schema.decodeEffect(Schema.fromJsonString(Releases))(got.body).pipe(
        Effect.option,
      );
      if (Option.isNone(releases)) return { result, error: "GitHub's answer was not understood" };
      if (releases.value.length === 0) break;
      for (const release of releases.value) {
        if (release.draft) continue;
        const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
        if (version === undefined) continue;
        (result[cliReleaseChannelOf(version)] ??= []).push(version);
      }
      if (channels.every((c) => (result[c]?.length ?? 0) > 0)) break;
    }
    return { result, error: null };
  });

const decodeCache = Schema.decodeEffect(Schema.fromJsonString(Cache));
const encodeCache = Schema.encodeEffect(Schema.fromJsonString(Cache));

export const lookupLatest = (
  t3Versions: ReadonlyArray<string>,
  cachePath: string = latestCachePath(process.env["HOME"] ?? ""),
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(cachePath).pipe(Effect.option);
    const read = Option.isSome(text)
      ? yield* decodeCache(text.value).pipe(Effect.option)
      : Option.none();
    const cache: Cache = {
      changed: false,
      entries: Option.match(read, { onNone: () => ({}), onSome: (c) => ({ ...c }) }),
    };
    const channels = [...new Set(t3Versions.map(cliReleaseChannelOf))];
    const [claude, codex, releases] = yield* Effect.all(
      [
        npmLatest(cache, AGENT_PACKAGES.claude),
        npmLatest(cache, AGENT_PACKAGES.codex),
        t3Releases(cache, channels),
      ],
      { concurrency: "unbounded" },
    );
    if (cache.changed) {
      // Written aside and moved, so a check running at the same time never reads half a file.
      const tmp = `${cachePath}.${process.pid}.tmp`;
      yield* encodeCache(cache.entries).pipe(
        Effect.flatMap((json) =>
          fs
            .makeDirectory(cachePath.slice(0, cachePath.lastIndexOf("/")), { recursive: true })
            .pipe(Effect.andThen(fs.writeFileString(tmp, json))),
        ),
        Effect.andThen(fs.rename(tmp, cachePath)),
        Effect.ignore,
      );
    }
    const t3: Partial<Record<CliReleaseChannel, T3Channel>> = {};
    for (const [channel, versions] of Object.entries(releases.result)) {
      t3[channel as CliReleaseChannel] = { versions };
    }
    const failed: { -readonly [K in keyof NonNullable<Latest["failed"]>]: string } = {};
    if (claude.error !== null) failed.claude = claude.error;
    if (codex.error !== null) failed.codex = codex.error;
    if (releases.error !== null) failed.t3 = releases.error;
    return {
      agents: { claude: claude.version, codex: codex.version },
      t3,
      ...(Object.keys(failed).length === 0 ? {} : { failed }),
    } satisfies Latest;
  });

/** How far `version` trails its channel: 0 when newest, null when unknown. */
export const releasesBehind = (
  latest: Latest,
  version: string,
): { readonly behind: number | null; readonly newest: string | null } => {
  const channel = latest.t3[cliReleaseChannelOf(version)];
  if (channel === undefined || channel.versions.length === 0) return { behind: null, newest: null };
  const index = channel.versions.indexOf(version);
  return { behind: index === -1 ? null : index, newest: channel.versions[0] ?? null };
};

export type LatestRequirements =
  | HttpClient.HttpClient
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem;
