/**
 * What T3 Fleet remembers between runs, so a scheduled check can say "nothing
 * changed" instead of repeating the same report every day.
 *
 * Also how intended differences apply. A finding listed in t3-fleet.toml
 * under `[[accept]]` is still reported, as a note naming the reason,
 * so it never comes back as a warning and never disappears silently.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { Finding } from "./Diagnose.ts";
import { stateDir } from "./Names.ts";

/** "laptop:t3-behind": the machine and what is wrong there, stable across checks. */
export const findingId = (f: Finding) => `${f.node}:${f.key}`;

const Remembered = Schema.Struct({
  checkedAt: Schema.Number,
  findings: Schema.Array(Schema.Struct({ id: Schema.String, severity: Schema.String, title: Schema.String })),
});
type Remembered = typeof Remembered.Type;

const statePath = () => `${stateDir(process.env["HOME"] ?? "")}/last-check.json`;

/** An [[accept]] id written before the rename: the engine's keys were fleetx-*. Until 1.0. */
const renamedId = (id: string) => id.replace(/:fleetx-(outdated|local-config|timer|timer-unwanted)$/, ":engine-$1");

/** Findings with accepted differences (t3-fleet.toml `[[accept]]`) turned into notes. */
export const applyAccepted = (findings: ReadonlyArray<Finding>, accepted: ReadonlyArray<{ readonly id: string; readonly reason: string }> = []) => {
  const reasons = new Map(accepted.map((a) => [renamedId(a.id), a.reason]));
  return findings.map((f): Finding => {
    const reason = reasons.get(findingId(f));
    if (reason === undefined) return f;
    const { fix: _fix, ...rest } = f;
    return { ...rest, severity: "info", detail: `accepted: ${reason}` };
  });
};

export interface Changes {
  /** Null on the first check. */
  readonly since: number | null;
  readonly appeared: ReadonlyArray<Finding>;
  readonly resolved: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly worsened: ReadonlyArray<Finding>;
}

const RANK: Readonly<Record<string, number>> = { error: 0, warn: 1, info: 2 };

/**
 * Compare against the last remembered check, then remember this one. Notes
 * are left out on both sides: they are not worth interrupting anyone for.
 */
export const compareWithLast = (findings: ReadonlyArray<Finding>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(statePath()).pipe(Effect.option);
    const previous: Option.Option<Remembered> = Option.isSome(text)
      ? yield* Schema.decodeEffect(Schema.fromJsonString(Remembered))(text.value).pipe(Effect.option)
      : Option.none();
    const current = findings.filter((f) => f.severity !== "info");
    const before = new Map(Option.match(previous, { onNone: () => [], onSome: (p) => p.findings }).map((f) => [f.id, f]));
    const now = new Set(current.map(findingId));
    const changes: Changes = {
      since: Option.match(previous, { onNone: () => null, onSome: (p) => p.checkedAt }),
      appeared: Option.isNone(previous) ? current : current.filter((f) => !before.has(findingId(f))),
      worsened: current.filter((f) => {
        const was = before.get(findingId(f));
        return was !== undefined && (RANK[f.severity] ?? 2) < (RANK[was.severity] ?? 2);
      }),
      resolved: [...before.values()].filter((f) => !now.has(f.id)).map((f) => ({ id: f.id, title: f.title })),
    };
    const remembered: Remembered = {
      checkedAt: yield* Clock.currentTimeMillis,
      findings: current.map((f) => ({ id: findingId(f), severity: f.severity, title: f.title })),
    };
    yield* fs.makeDirectory(path.dirname(statePath()), { recursive: true }).pipe(Effect.ignore);
    yield* Schema.encodeEffect(Schema.fromJsonString(Remembered))(remembered).pipe(
      Effect.flatMap((json) => fs.writeFileString(statePath(), json)),
      Effect.ignore,
    );
    return changes;
  });

export const hasChanges = (c: Changes) => c.appeared.length + c.resolved.length + c.worsened.length > 0;
