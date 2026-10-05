/** Deterministic delivery. The ledger belongs to a machine, independently of MCP's seen cursor. */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import type { Config } from "./Config.ts";
import { exec, type ExecInput } from "./Exec.ts";
import { sha256 } from "./Hash.ts";
import { stateDir } from "./Names.ts";
import { localSecretsPath } from "./Secrets.ts";
import type { Alert, NodeState } from "./State.ts";
import { withMachineLock } from "./SyncLock.ts";

export type Channel = "desktop" | "ntfy";
export interface Notification {
  readonly title: string;
  readonly body: string;
  readonly problem: boolean;
}
export class NotifyError extends Schema.TaggedError<NotifyError>()("NotifyError", {
  message: Schema.String,
  retryable: Schema.Boolean,
}) {}

const Delivery = Schema.Struct({
  ids: Schema.Array(Schema.String),
  status: Schema.String,
});
const Ledger = Schema.Record(Schema.String, Delivery);
type Ledger = Record<string, typeof Delivery.Type>;
const decodeLedger = Schema.decodeEffect(Schema.fromJsonString(Ledger));
const encodeLedger = Schema.encodeEffect(Schema.fromJsonString(Ledger));
const encodeIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.Number, Schema.String, Schema.String, Schema.String])),
);
export const alertIdentity = (a: Alert) => encodeIdentity([a.at, a.node, a.kind, a.message]);

/** With a configured relay, only its service pushes. A member's sync never takes over. */
export const deliveryChannels = (config: Config, source: "sync" | "relay" | "listen") => {
  const notify = config.settings.notify;
  if (notify === undefined) return [];
  const hasRelay = config.settings.relay !== undefined;
  const desktop = notify.desktop?.includes(config.self) === true;
  const channels: Array<Channel> = [];
  if (
    source === "relay" &&
    !config.nodes.some((n) => n.name === config.self && n.roles.includes("relay"))
  )
    return channels;
  if (notify.ntfy !== undefined && (hasRelay ? source === "relay" : source === "sync"))
    channels.push("ntfy");
  if (desktop && (hasRelay ? source !== "sync" : source === "sync")) channels.push("desktop");
  return channels;
};

export const notificationFor = (alerts: ReadonlyArray<Alert>, summary: boolean): Notification => {
  const problem = alerts.some((a) => a.kind === "problem" || a.kind === "failing");
  const first = alerts[0];
  if (!summary && first !== undefined)
    return {
      title: `T3 Fleet: ${first.node} ${problem ? "needs attention" : "recovered"}`,
      body: first.message,
      problem,
    };
  const nodes = [...new Set(alerts.map((a) => a.node))];
  const problems = alerts.filter((a) => a.kind === "problem" || a.kind === "failing").length;
  return {
    title: `T3 Fleet: ${alerts.length} alert${alerts.length === 1 ? "" : "s"} since last delivery`,
    body: `${nodes.join(", ")}: ${problems} problem${problems === 1 ? "" : "s"}, ${alerts.length - problems} resolved. Run t3-fleet alerts for details.`,
    problem,
  };
};

/** Data is passed as argv, never interpreted as AppleScript source or a shell command. */
export const desktopCommand = (platform: string, n: Notification): ExecInput =>
  platform === "darwin"
    ? {
        command: "osascript",
        args: [
          "-e",
          "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run",
          "--",
          n.title,
          n.body,
        ],
      }
    : { command: "notify-send", args: ["--app-name=T3 Fleet", "--", n.title, n.body] };

export const desktopAvailable = Effect.gen(function* () {
  if (process.platform === "darwin") {
    // A launch daemon or ssh session has no WindowServer session to display in.
    const session = yield* exec({
      command: "stat",
      args: ["-f", "%u", "/dev/console"],
      timeout: Duration.seconds(3),
    });
    if (session.code !== 0 || Number(session.stdout.trim()) !== process.getuid?.()) return false;
  } else if (
    process.platform !== "linux" ||
    (!process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"])
  )
    return false;
  const which = yield* exec({
    command: "which",
    args: [process.platform === "darwin" ? "osascript" : "notify-send"],
    timeout: Duration.seconds(3),
  });
  return which.code === 0;
});

const desktopSend = (n: Notification) =>
  Effect.gen(function* () {
    if (!(yield* desktopAvailable)) return "desktop skipped: no graphical session or OS notifier";
    const sent = yield* exec({
      ...desktopCommand(process.platform, n),
      timeout: Duration.seconds(5),
    });
    if (sent.code !== 0)
      return yield* new NotifyError({ message: "desktop notifier failed", retryable: false });
    return "delivered";
  });

/** Read only the installed, decrypted secrets file, at send time. No URL in an error or log. */
export const ntfyUrl = (name: string, home: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs
      .readFileString(localSecretsPath(home))
      .pipe(Effect.orElseSucceed(() => ""));
    const line = text
      .split("\n")
      .find((l) => l.startsWith(`${name}=`) || l.startsWith(`export ${name}=`));
    const value = (line?.slice(line.indexOf("=") + 1) ?? "")
      .replace(/^"(.*)"$/, "$1")
      .replace(/\\(.)/g, "$1");
    const valid = yield* Effect.try({
      try: () => {
        const u = new URL(value);
        return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password;
      },
      catch: () => false,
    }).pipe(Effect.orElseSucceed(() => false));
    if (!valid)
      return yield* new NotifyError({
        message: "ntfy secret missing or invalid topic URL",
        retryable: false,
      });
    return value;
  });

/** Failures are sanitized at the HTTP boundary, including transport errors containing the URL. */
export const ntfySend = (name: string, home: string, n: Notification) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = yield* ntfyUrl(name, home);
    const response = yield* client
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeader("Title", n.title.replace(/[^\x20-\x7e]/g, "?")),
          HttpClientRequest.setHeader("Priority", n.problem ? "4" : "2"),
          HttpClientRequest.setHeader("Tags", n.problem ? "warning" : "white_check_mark"),
          HttpClientRequest.bodyText(n.body),
        ),
      )
      .pipe(
        Effect.timeout(Duration.seconds(5)),
        Effect.mapError(
          () => new NotifyError({ message: "ntfy transport failed or timed out", retryable: true }),
        ),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* new NotifyError({
        message: `ntfy rejected notification (HTTP ${response.status})`,
        retryable: response.status === 429 || response.status >= 500,
      });
    return "delivered";
  }).pipe(
    Effect.retry({
      schedule: Schedule.exponential(Duration.millis(250)),
      times: 2,
      while: (e) => e.retryable,
    }),
  );

export interface NotifyOptions<E = never, R = never> {
  readonly home?: string;
  readonly now?: number;
  readonly catchUp?: boolean;
  /** Tests replace both transports; production never selects a fake by environment variable. */
  readonly send?: (channel: Channel, n: Notification) => Effect.Effect<string, E, R>;
}

const ledgerPath = (config: Config, home: string) =>
  Effect.promise(() => sha256(config.repo)).pipe(
    Effect.map((id) => `${stateDir(home)}/notify-${id}.json`),
  );

/** Persist identities, rather than timestamps, so clock corrections cannot lose a new alert. */
export const deliverAlerts = <E = never, R = never>(
  config: Config,
  states: ReadonlyArray<NodeState>,
  source: "sync" | "relay" | "listen",
  options: NotifyOptions<E, R> = {},
) =>
  Effect.gen(function* () {
    const channels = deliveryChannels(config, source);
    if (channels.length === 0) return [] as Array<string>;
    const home = options.home ?? process.env["HOME"] ?? "";
    const file = yield* ledgerPath(config, home);
    const now = options.now ?? (yield* Clock.currentTimeMillis);
    const fs = yield* FileSystem.FileSystem;
    const send: (
      channel: Channel,
      n: Notification,
    ) => Effect.Effect<
      string,
      E | NotifyError,
      R | FileSystem.FileSystem | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
    > =
      options.send ??
      ((channel: Channel, n: Notification) =>
        channel === "desktop"
          ? desktopSend(n)
          : ntfySend(config.settings.notify?.ntfy ?? "", home, n));
    const run = Effect.gen(function* () {
      // Missing is new; unreadable or corrupt is an error, never silently reset a dedupe cursor.
      const exists = yield* fs.exists(file);
      const ledger: Ledger = exists
        ? yield* fs.readFileString(file).pipe(Effect.flatMap(decodeLedger))
        : {};
      const save = () =>
        encodeLedger(ledger).pipe(
          Effect.flatMap((text) => fs.writeFileString(`${file}.tmp`, text, { mode: 0o600 })),
          Effect.andThen(fs.rename(`${file}.tmp`, file)),
        );
      const lines: Array<string> = [];
      const all = [
        ...new Map(
          states
            .filter((s) => source !== "sync" || s.node === config.self)
            .flatMap((s) => s.alerts)
            .map((a) => [alertIdentity(a), a]),
        ).values(),
      ].sort((a, b) => a.at - b.at);
      const identified = yield* Effect.forEach(all, (a) =>
        Effect.promise(() => sha256(alertIdentity(a))).pipe(Effect.map((id) => ({ a, id }))),
      );
      for (const channel of channels) {
        const previous = ledger[channel] ?? { ids: [], status: "ready" };
        const delivered = new Set(previous.ids);
        const unseen = identified.filter(({ id }) => !delivered.has(id));
        if (unseen.length === 0) continue;
        const summary =
          options.catchUp === true ||
          unseen.length > 1 ||
          unseen.some(({ a }) => now - a.at > 120_000);
        const batches = summary ? [unseen] : unseen.map((a) => [a]);
        for (const batch of batches) {
          const before = ledger[channel] ?? previous;
          const ids = [...before.ids, ...batch.map(({ id }) => id)];
          // Write ahead: a process dying after OS/HTTP acceptance cannot replay this batch.
          ledger[channel] = {
            ids,
            status: "delivery interrupted or in progress; receipt unconfirmed",
          };
          yield* save();
          const result = yield* send(
            channel,
            notificationFor(
              batch.map(({ a }) => a),
              summary,
            ),
          ).pipe(Effect.result);
          const status =
            result._tag === "Success"
              ? result.success
              : Schema.is(NotifyError)(result.failure)
                ? result.failure.message
                : "notification transport failed";
          // A definite returned failure remains eligible on the next pass. A crashed sender's claim stays.
          ledger[channel] = { ids: result._tag === "Success" ? ids : before.ids, status };
          yield* save();
          lines.push(`${channel}: ${status}`);
          if (result._tag === "Failure") break;
        }
      }
      return lines;
    });
    return yield* withMachineLock(`${file}.lock`, run, Effect.succeed([] as Array<string>));
  }).pipe(Effect.orElseSucceed(() => ["notifications: cannot read or persist delivery ledger"]));

/** Read-only local status, also used by doctor. */
export const notificationStatus = (config: Config) =>
  Effect.gen(function* () {
    if (config.settings.notify === undefined) return [] as Array<string>;
    const home = process.env["HOME"] ?? "";
    const fs = yield* FileSystem.FileSystem;
    const file = yield* ledgerPath(config, home);
    const ledger = (yield* fs.exists(file))
      ? yield* fs.readFileString(file).pipe(Effect.flatMap(decodeLedger))
      : {};
    const lines: Array<string> = [];
    for (const [channel, delivery] of Object.entries(ledger))
      if (delivery.status !== "delivered") lines.push(`notify ${channel}: ${delivery.status}`);
    if (config.settings.notify.desktop?.includes(config.self) && !(yield* desktopAvailable))
      lines.push("notify desktop info: skipped; no graphical session or OS notifier");
    if (
      deliveryChannels(config, "sync").includes("ntfy") ||
      deliveryChannels(config, "relay").includes("ntfy")
    ) {
      const valid = yield* ntfyUrl(config.settings.notify.ntfy ?? "", home).pipe(Effect.result);
      if (valid._tag === "Failure") lines.push(`notify ntfy: ${valid.failure.message}`);
    }
    return lines;
  }).pipe(Effect.orElseSucceed(() => ["notify: delivery ledger unreadable"]));

/** Explicit user-requested test, independent of the alert identities, with persisted results. */
export const testNotification = <E = never, R = never>(
  config: Config,
  options: NotifyOptions<E, R> = {},
) =>
  Effect.gen(function* () {
    const notify = config.settings.notify;
    if (notify === undefined) return { lines: ["no [notify] paths configured"], failed: false };
    const n: Notification = {
      title: "T3 Fleet: notification test",
      body: `Test requested on ${config.self}`,
      problem: false,
    };
    const channels: Array<Channel> = [];
    if (notify.desktop?.includes(config.self)) channels.push("desktop");
    if (notify.ntfy !== undefined) channels.push("ntfy");
    if (channels.length === 0)
      return { lines: ["no notification paths configured for this node"], failed: false };
    const home = options.home ?? process.env["HOME"] ?? "";
    const fs = yield* FileSystem.FileSystem;
    const file = yield* ledgerPath(config, home);
    const send: (
      channel: Channel,
      n: Notification,
    ) => Effect.Effect<
      string,
      E | NotifyError,
      R | FileSystem.FileSystem | HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
    > =
      options.send ??
      ((channel, message) =>
        channel === "desktop" ? desktopSend(message) : ntfySend(notify.ntfy ?? "", home, message));
    const run = Effect.gen(function* () {
      const ledger: Ledger = (yield* fs.exists(file))
        ? yield* fs.readFileString(file).pipe(Effect.flatMap(decodeLedger))
        : {};
      const lines: Array<string> = [];
      let failed = false;
      for (const channel of channels) {
        const sent = yield* send(channel, n).pipe(Effect.result);
        const status =
          sent._tag === "Success"
            ? sent.success
            : Schema.is(NotifyError)(sent.failure)
              ? sent.failure.message
              : "notification transport failed";
        failed ||= sent._tag === "Failure";
        ledger[channel] = { ids: ledger[channel]?.ids ?? [], status };
        yield* fs.writeFileString(`${file}.tmp`, yield* encodeLedger(ledger), { mode: 0o600 });
        yield* fs.rename(`${file}.tmp`, file);
        lines.push(`${channel}: ${status}`);
      }
      return { lines, failed };
    });
    return yield* withMachineLock(
      `${file}.lock`,
      run,
      Effect.succeed({
        lines: ["another notification delivery is running; try again"],
        failed: true,
      }),
    );
  }).pipe(
    Effect.orElseSucceed(() => ({
      lines: ["notifications: cannot read or persist delivery ledger"],
      failed: true,
    })),
  );
