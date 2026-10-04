/**
 * The tool-call log: every JSON-RPC request through the gateway, as a
 * `HubCall` (server, client, method, tool, duration, outcome). Never
 * arguments, never results: what a call was for stays between the client and
 * the server.
 *
 * Recent calls sit in a ring buffer for `GET /hub/calls`; all of them are
 * appended to calls.jsonl, which is cut back to the ring's contents when it
 * outgrows its bound, so the file never grows without limit. A restart
 * reloads the ring from the file.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { HubCall } from "../Api.ts";

/** Every field a client controls is cut short before it is kept. */
export const MAX_FIELD = 128;
const clip = (text: string | null, max: number) =>
  text === null ? null : text.length > max ? `${text.slice(0, max - 1)}…` : text;

export interface CallLog {
  readonly record: (call: HubCall) => Effect.Effect<void>;
  readonly list: (filter: {
    readonly server?: string | undefined;
    readonly limit?: number | undefined;
  }) => Effect.Effect<ReadonlyArray<HubCall>>;
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(HubCall));
const encodeLine = Schema.encodeUnknownOption(Schema.fromJsonString(HubCall));

/** `file` null keeps the log in memory only. */
export const makeCallLog = (
  file: string | null,
  options?: { readonly capacity?: number; readonly maxBytes?: number },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const capacity = options?.capacity ?? 1000;
    const maxBytes = options?.maxBytes ?? 4_000_000;
    let ring: Array<HubCall> = [];
    let bytes = 0;

    if (file !== null) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(Effect.ignore);
      const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
      bytes = text.length;
      for (const line of text.split("\n")) {
        const call = decodeLine(line);
        if (Option.isSome(call)) ring.push(call.value);
      }
      ring = ring.slice(-capacity);
    }

    const write = (call: HubCall) =>
      Effect.gen(function* () {
        if (file === null) return;
        const line = Option.getOrNull(encodeLine(call));
        if (line === null) return;
        if (bytes + line.length + 1 > maxBytes) {
          const all = ring
            .map((c) => Option.getOrElse(encodeLine(c), () => ""))
            .filter((l) => l !== "");
          const text = all.length === 0 ? "" : `${all.join("\n")}\n`;
          yield* fs.writeFileString(file, text, { mode: 0o600 });
          bytes = text.length;
        } else {
          yield* fs.writeFileString(file, `${line}\n`, { flag: "a", mode: 0o600 });
          bytes += line.length + 1;
        }
      }).pipe(Effect.ignore);

    const log: CallLog = {
      record: (raw) =>
        Effect.suspend(() => {
          const call: HubCall = {
            ...raw,
            server: clip(raw.server, MAX_FIELD) ?? "",
            client: clip(raw.client, MAX_FIELD) ?? "",
            method: clip(raw.method, MAX_FIELD) ?? "",
            tool: clip(raw.tool, MAX_FIELD),
            error: clip(raw.error, 200),
          };
          ring.push(call);
          if (ring.length > capacity) ring = ring.slice(-capacity);
          return write(call);
        }),
      list: ({ server, limit }) =>
        Effect.sync(() => {
          const matching =
            server === undefined || server === "" ? ring : ring.filter((c) => c.server === server);
          const n = Math.max(1, Math.min(limit ?? 100, capacity));
          return matching.slice(-n).reverse();
        }),
    };
    return log;
  });
