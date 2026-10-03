/**
 * What the model proxy remembers about traffic: one small record per request,
 * metadata only, never a body or a header. Records live in memory for the
 * rolling windows (5 minutes, 1 hour, 24 hours) and are appended to
 * ~/.local/state/fleetx/models.jsonl, so a restarted proxy keeps its last day
 * and a person can read what happened. The log is bounded: past a size it is
 * rotated to models.jsonl.1, and only those two files exist.
 *
 * Fallbacks are counted from the launchers' log
 * (~/.local/state/fleetx/models-fallback.log): a launcher only falls back when
 * the proxy is not listening, so the proxy cannot count them itself.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ModelFailureClass, ModelUpstream, type ModelProxyStats, type ModelUpstreamStats, type ModelWindow } from "../Api.ts";

export const RequestRecord = Schema.Struct({
  /** When the request finished, ms since the epoch. */
  at: Schema.Number,
  upstream: ModelUpstream,
  method: Schema.String,
  /** The upstream path, without the query string. */
  path: Schema.String,
  /** The status the client got; null when it got none (connect error, timeout). */
  status: Schema.NullOr(Schema.Number),
  /** Upstream attempts; more than one means it was retried before the first byte. */
  attempts: Schema.Number,
  ttfbMs: Schema.NullOr(Schema.Number),
  durationMs: Schema.Number,
  failure: Schema.NullOr(ModelFailureClass),
  /** A short reason for a failure: a status line or a network error, never content. */
  error: Schema.NullOr(Schema.String),
});
export type RequestRecord = typeof RequestRecord.Type;

export interface Fallback {
  readonly at: number;
  readonly upstream: ModelUpstream;
}

export const MINUTE = 60_000;
export const WINDOWS = { m5: 5 * MINUTE, h1: 60 * MINUTE, h24: 24 * 60 * MINUTE } as const;

/** Records kept in memory: a busy machine's day, with room to spare. */
export const MAX_RECORDS = 200_000;
/** Rotate models.jsonl past this size. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;

export const statsLogPath = (home: string) => `${home}/.local/state/fleetx/models.jsonl`;
export const fallbackLogPath = (home: string) => `${home}/.local/state/fleetx/models-fallback.log`;

/** Nearest-rank percentile; null for no samples. */
export const percentile = (values: ReadonlyArray<number>, p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? null;
};

export const windowOf = (records: ReadonlyArray<RequestRecord>, fallbacks: ReadonlyArray<Fallback>, since: number): ModelWindow => {
  const inWindow = records.filter((r) => r.at >= since);
  const failures: Record<string, number> = {};
  for (const r of inWindow) if (r.failure !== null) failures[r.failure] = (failures[r.failure] ?? 0) + 1;
  const ttfb = inWindow.flatMap((r) => (r.ttfbMs === null ? [] : [r.ttfbMs]));
  return {
    requests: inWindow.length,
    retried: inWindow.filter((r) => r.attempts > 1).length,
    failed: inWindow.filter((r) => r.failure !== null).length,
    failures,
    fallbacks: fallbacks.filter((f) => f.at >= since).length,
    ttfbP50Ms: percentile(ttfb, 50),
    ttfbP95Ms: percentile(ttfb, 95),
  };
};

export const upstreamStats = (
  upstream: ModelUpstream,
  records: ReadonlyArray<RequestRecord>,
  fallbacks: ReadonlyArray<Fallback>,
  now: number,
): ModelUpstreamStats => {
  const own = records.filter((r) => r.upstream === upstream && r.at >= now - WINDOWS.h24);
  const ownFallbacks = fallbacks.filter((f) => f.upstream === upstream && f.at >= now - WINDOWS.h24);
  const last = own.reduce<RequestRecord | undefined>((latest, r) => (r.failure !== null && (latest === undefined || r.at >= latest.at) ? r : latest), undefined);
  return {
    upstream,
    m5: windowOf(own, ownFallbacks, now - WINDOWS.m5),
    h1: windowOf(own, ownFallbacks, now - WINDOWS.h1),
    h24: windowOf(own, ownFallbacks, now - WINDOWS.h24),
    lastError: last?.failure == null ? null : { at: last.at, class: last.failure, message: last.error ?? last.failure },
  };
};

export const proxyStats = (input: {
  readonly now: number;
  readonly startedAt: number;
  readonly version: string;
  readonly egress: "direct" | "relay";
  readonly records: ReadonlyArray<RequestRecord>;
  readonly fallbacks: ReadonlyArray<Fallback>;
}): ModelProxyStats => ({
  at: input.now,
  startedAt: input.startedAt,
  version: input.version,
  egress: input.egress,
  upstreams: ModelUpstream.literals.map((u) => upstreamStats(u, input.records, input.fallbacks, input.now)),
});

/** Launcher lines: `<epoch seconds>\t<anthropic|openai>\t<reason>`. Unreadable lines are skipped. */
export const parseFallbacks = (text: string): Array<Fallback> =>
  text.split("\n").flatMap((line) => {
    const [when, upstream] = line.split("\t");
    const at = Number(when) * 1000;
    return Number.isFinite(at) && at > 0 && (upstream === "anthropic" || upstream === "openai") ? [{ at, upstream }] : [];
  });

const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(RequestRecord));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(RequestRecord));

export const parseRecords = (text: string, since: number): Array<RequestRecord> =>
  text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    const record = decodeRecord(line);
    return Option.isSome(record) && record.value.at >= since ? [record.value] : [];
  });

/** The last day of records from the log (rotated file first), for a proxy that just started. */
export const loadRecords = (home: string, now: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    const since = now - WINDOWS.h24;
    return [...parseRecords(yield* read(`${statsLogPath(home)}.1`), since), ...parseRecords(yield* read(statsLogPath(home)), since)].slice(-MAX_RECORDS);
  });

export const loadFallbacks = (home: string, now: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(fallbackLogPath(home)).pipe(Effect.orElseSucceed(() => ""));
    return parseFallbacks(text).filter((f) => f.at >= now - WINDOWS.h24);
  });

/** Appends one record; rotates the log when it has grown past MAX_LOG_BYTES. A full disk never fails a request. */
export const appendRecord = (home: string, record: RequestRecord) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = statsLogPath(home);
    yield* fs.writeFileString(file, `${encodeRecord(record)}\n`, { flag: "a" });
    const info = yield* fs.stat(file);
    if (Number(info.size) > MAX_LOG_BYTES) yield* fs.rename(file, `${file}.1`);
  }).pipe(Effect.ignore);
