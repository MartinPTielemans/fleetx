/**
 * Who may open the app on the hub.
 *
 * The relay publishes its loopback port on the tailnet with `tailscale serve`
 * (areas/RelayArea.ts), and serves the app there too, beside its own routes.
 * Being on the tailnet is not enough to open it: the app shows every machine
 * and runs fixes. Tailscale serve tells the backend who is asking, in
 * headers it sets itself and strips from what the browser sent:
 *
 *   Tailscale-User-Login      the login of the user whose device asked;
 *                             RFC 2047 Q-encoded when not ASCII
 *   Tailscale-Funnel-Request  "?1" for a request from the internet through
 *                             Funnel, which carries no login
 *
 * A device that is tagged (a server, rather than a person's) gets no login
 * headers at all. So a request is let in only when:
 *
 *   it came from loopback      tailscale serve proxies from this machine; a
 *                              connection from anywhere else could have set the
 *                              headers itself (the relay listens on 127.0.0.1,
 *                              so this holds unless someone changes that)
 *   Host is the relay's        serve passes the browser's Host through; the
 *                              relay's tailnet name, never another (DNS
 *                              rebinding)
 *   Origin, when sent, is too  no other site drives it from the same browser
 *   not through Funnel         the app is never served to the internet
 *   with a login in [ui] allow the logins the fleet lets in
 *
 *   and tailscaled made the   loopback alone would let any program on the hub
 *   connection                connect and set the headers itself. The kernel
 *                             says whose socket the other end of the connection
 *                             is. On Linux (/proc/net/tcp) it must be root's, as
 *                             tailscaled is when installed as a package; or, for
 *                             a tailscaled run as a user, that user's, but only
 *                             when systemd started it as its tailscaled unit
 *                             (MainPID) from an installed program: root's, in
 *                             root's directories, none writable by anyone else.
 *                             A process merely named tailscaled, which anyone
 *                             can start, says nothing. On macOS (the TCP
 *                             table sysctl gives, net.inet.tcp.pcblist_n) it
 *                             must be root's (the standalone app's system
 *                             extension, or tailscaled as a daemon), or the
 *                             process must be the App Store app's network
 *                             extension, which runs as the logged-in user: its
 *                             code signature, checked on the running process,
 *                             says so. A program run by anyone else, the
 *                             relay's own user included, is refused
 *                             (servedByTailscale)
 *
 * Why not a Unix socket for tailscale serve to proxy to, which only the
 * relay's user could open: since Tailscale 1.98.9 (TS-2026-005) only root may
 * set a Unix socket as a Serve target, and the relay sets its Serve up
 * unattended, as its own user. Why not Tailscale's whois: the connection
 * reaching the relay is tailscaled's own, from 127.0.0.1, and a forged
 * request can name any device's address in a header.
 *
 * What remains: root on the hub (or the user tailscaled runs as, when that is
 * not root, on Linux) can pose as any login; it can read every secret there
 * anyway. A hub that is neither Linux nor macOS, a Mac whose tailscaled runs
 * as a user (the open-source daemon with userspace networking, which no
 * signature names), or a Linux hub whose tailscaled runs as a user other than
 * under its systemd unit from an installed program, cannot tell its
 * connections apart, so its app refuses everyone; setup notes it (`[ui]
 * hosted = false`) and `t3-fleet ui` serves the app on each machine instead.
 *
 * Passing the gate is not a session: the app still trades it for a token,
 * bound to that login, which every /api request sends as a header (UiServer.ts).
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { exec } from "./Exec.ts";

export interface HubGate {
  /** `[relay] url`: the only Host and Origin the app answers to. */
  readonly url: string;
  /** `[ui] allow`: Tailscale logins, compared without case. */
  readonly allow: ReadonlyArray<string>;
}

export interface GateRequest {
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** The connection's peer address; null when unknown. */
  readonly remoteAddress: string | null;
}

export type Identity =
  | { readonly ok: true; readonly login: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly title: string;
      readonly message: string;
      /** The login the request came with, to say which one to add. */
      readonly login: string | null;
    };

const isLoopback = (address: string | null) =>
  address !== null &&
  (/^127\.\d+\.\d+\.\d+$/.test(address) ||
    address === "::1" ||
    /^::ffff:127\.\d+\.\d+\.\d+$/i.test(address));

/** RFC 2047 encoded words ("=?utf-8?q?Zo=C3=AB?="), as Tailscale writes non-ASCII values; anything else as it is. */
export const decodeHeaderValue = (value: string) =>
  value.replace(/=\?utf-8\?([qb])\?([^?]*)\?=/gi, (whole, kind: string, text: string) => {
    try {
      if (kind.toLowerCase() === "b") {
        const binary = atob(text);
        return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
      }
      const bytes: Array<number> = [];
      for (let i = 0; i < text.length; i++) {
        const c = text[i] ?? "";
        if (c === "_") bytes.push(0x20);
        else if (c === "=" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
          bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(c.charCodeAt(0));
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
      return whole;
    }
  });

/** Host and origin of `[relay] url`; null when it is not a URL. */
export const hubAddress = (url: string) => {
  try {
    const parsed = new URL(url);
    const defaultPort = parsed.protocol === "https:" ? "443" : "80";
    return {
      origin: parsed.origin,
      hosts: [parsed.host, ...(parsed.port === "" ? [`${parsed.hostname}:${defaultPort}`] : [])],
    };
  } catch {
    return null;
  }
};

/** Whether `request` may use the app on the hub, and as whom. */
export const identify = (request: GateRequest, gate: HubGate): Identity => {
  const refuse = (status: number, title: string, message: string, login: string | null = null) =>
    ({ ok: false, status, title, message, login }) as const;
  if (!isLoopback(request.remoteAddress))
    return refuse(
      403,
      "Not through Tailscale",
      "The app on the hub answers only requests that tailscale serve forwards on this machine.",
    );
  const address = hubAddress(gate.url);
  if (address === null)
    return refuse(503, "No hub address", "[relay] url in t3-fleet.toml is not a URL.");
  const host = request.headers["host"]?.toLowerCase();
  if (host === undefined || !address.hosts.includes(host))
    return refuse(421, "Wrong address", `Open the app at ${address.origin}.`);
  const origin = request.headers["origin"];
  if (origin !== undefined && origin !== address.origin)
    return refuse(403, "Cross-origin request", "Requests from other sites are refused.");
  if (request.headers["tailscale-funnel-request"] !== undefined)
    return refuse(
      403,
      "Not on the internet",
      "This request came through Tailscale Funnel. The app on the hub is only for your tailnet; turn Funnel off for this port.",
    );
  const raw = request.headers["tailscale-user-login"];
  if (raw === undefined || raw.trim() === "")
    return refuse(
      401,
      "No Tailscale login",
      "Tailscale did not say who is asking. Requests from tagged devices carry no login; open the app from a device signed in as a person.",
    );
  const login = decodeHeaderValue(raw.trim());
  const allowed = gate.allow.some((a) => a.trim().toLowerCase() === login.toLowerCase());
  if (!allowed)
    return refuse(
      403,
      "Not allowed",
      gate.allow.length === 0
        ? "No login may open the app on this hub yet."
        : `${login} is not among the logins allowed to open this app.`,
      login,
    );
  return { ok: true, login };
};

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );

/** The page a refused browser gets: what happened, which login was seen, how to add it. */
export const refusedPage = (refused: Extract<Identity, { ok: false }>) => {
  const add =
    refused.login === null
      ? ""
      : `<p>To let ${escapeHtml(refused.login)} in, add it on an authority:</p>
<pre>[ui]
allow = [${escapeHtml(JSON.stringify(refused.login))}]</pre>
<p>in <code>t3-fleet.toml</code> of the fleet's repo (with any logins already there), commit and push. The hub reads it within a minute of its next sync.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>T3 Fleet: ${escapeHtml(refused.title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}pre,code{background:#f3f3f3;border-radius:4px}pre{padding:.75rem}h1{font-size:1.3rem}@media(prefers-color-scheme:dark){body{background:#161616;color:#ddd}pre,code{background:#262626}}</style>
</head><body><h1>${escapeHtml(refused.title)}</h1>
<p>${escapeHtml(refused.message)}</p>
${refused.login === null ? "" : `<p>Signed in to Tailscale as <strong>${escapeHtml(refused.login)}</strong>.</p>`}
${add}
</body></html>
`;
};

// ── who made the connection ─────────────────────────────────────────────

/** The two ports of a TCP connection, as the server saw them. */
export interface Connection {
  /** The asking side's port: its socket on this machine, on loopback. */
  readonly remotePort: number;
  /** The relay's own port. */
  readonly localPort: number;
}

/** The connection under a request, from the Node request it came as; null when it cannot be told. */
export const connectionOf = (source: unknown): Connection | null => {
  const socket = (source as { socket?: { remotePort?: unknown; localPort?: unknown } } | null)
    ?.socket;
  const remotePort = socket?.remotePort;
  const localPort = socket?.localPort;
  return typeof remotePort === "number" && typeof localPort === "number"
    ? { remotePort, localPort }
    : null;
};

/**
 * The uid owning the asking end of `connection`, from /proc/net/tcp or tcp6
 * text: the socket whose local port is the connection's remote port, talking
 * to the relay's port. Null when no such socket is listed.
 */
export const socketOwner = (procNet: string, connection: Connection): number | null => {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  const local = `:${hex(connection.remotePort)}`;
  const remote = `:${hex(connection.localPort)}`;
  for (const line of procNet.split("\n").slice(1)) {
    // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid ...
    const f = line.trim().split(/\s+/);
    const [, at, to, , , , , uid] = f;
    if (at?.endsWith(local) && to?.endsWith(remote) && uid !== undefined && /^\d+$/.test(uid))
      return Number(uid);
  }
  return null;
};

// ── on Linux ───────────────────────────────────────────────────────────

/** The real uid in a /proc/<pid>/status text; null when it has none. */
export const statusUid = (status: string): number | null => {
  const uid = /^Uid:\s*(\d+)/m.exec(status)?.[1];
  return uid === undefined ? null : Number(uid);
};

/** Who owns a path, and its permission bits. */
export interface PathOwner {
  readonly uid: number;
  readonly mode: number;
}

/** `path` and every directory above it, up to the root. */
const withParents = (path: string) => {
  const all = [path];
  for (let at = path; at !== "/" && at !== "";)
    all.push((at = at.slice(0, at.lastIndexOf("/")) || "/"));
  return all;
};

/**
 * Whether `exe`, a program's absolute path as /proc/<pid>/exe resolves it, is
 * an installed tailscaled: named tailscaled, and it and every directory above
 * it are root's and writable by no one else, so no user could have put it
 * there or changed it. A program replaced while it runs reads "(deleted)",
 * whose path no longer exists: not one. `owner` is null for a path it cannot
 * read, which is not one either.
 */
export const installedTailscaled = (
  exe: string,
  owner: (path: string) => PathOwner | null,
): boolean => {
  if (!exe.startsWith("/") || exe.split("/").at(-1) !== "tailscaled") return false;
  return withParents(exe).every((path) => {
    const o = owner(path);
    return o !== null && o.uid === 0 && (o.mode & 0o022) === 0;
  });
};

/** What the Linux check reads besides /proc's tables: commands and files in practice, fakes in tests. */
export interface LinuxLookup {
  /**
   * tailscaled's main process, as systemd tracks it: the system unit's, else
   * the relay's user's own unit's. Null when neither runs.
   */
  readonly mainPid: Effect.Effect<number | null, never, ChildProcessSpawner.ChildProcessSpawner>;
  /** The program process `pid` runs (/proc/<pid>/exe); null when it cannot be read. */
  readonly exe: (pid: number) => Effect.Effect<string | null, never, FileSystem.FileSystem>;
  /** Owners of a path and of each directory above it, read together; null for one that cannot be read. */
  readonly owners: (
    paths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, PathOwner | null>, never, FileSystem.FileSystem>;
}

const unitMainPid = (user: boolean) =>
  exec({
    command: "systemctl",
    args: [...(user ? ["--user"] : []), "show", "-p", "MainPID", "--value", "tailscaled.service"],
    timeout: Duration.seconds(5),
  }).pipe(
    Effect.map((r) => {
      const pid = r.code === 0 ? Number(r.stdout.trim()) : 0;
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    }),
  );

export const liveLinuxLookup: LinuxLookup = {
  mainPid: Effect.gen(function* () {
    return (yield* unitMainPid(false)) ?? (yield* unitMainPid(true));
  }),
  exe: (pid) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.readLink(`/proc/${pid}/exe`).pipe(Effect.orElseSucceed(() => null));
    }),
  owners: (paths) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const owners = new Map<string, PathOwner | null>();
      for (const path of paths) {
        // stat follows a symlink: the path itself must not be one.
        const link = yield* fs.readLink(path).pipe(Effect.option);
        const info = yield* fs.stat(path).pipe(Effect.option);
        owners.set(
          path,
          link._tag === "None" && info._tag === "Some" && info.value.uid._tag === "Some"
            ? { uid: info.value.uid.value, mode: info.value.mode }
            : null,
        );
      }
      return owners;
    }),
};

/**
 * The uid tailscaled runs as, when it is not root: that of the process
 * systemd started as its tailscaled unit, when that process runs an
 * installed tailscaled (installedTailscaled). Null otherwise: a program
 * merely named tailscaled, which any user can start, is not it.
 */
export const tailscaledUser = (proc: string, lookup: LinuxLookup) =>
  Effect.gen(function* () {
    const pid = yield* lookup.mainPid;
    if (pid === null) return null;
    const fs = yield* FileSystem.FileSystem;
    const status = yield* fs
      .readFileString(`${proc}/${pid}/status`)
      .pipe(Effect.orElseSucceed(() => ""));
    const uid = statusUid(status);
    const exe = yield* lookup.exe(pid);
    if (uid === null || exe === null) return null;
    const owners = yield* lookup.owners(exe.startsWith("/") ? withParents(exe) : []);
    return installedTailscaled(exe, (path) => owners.get(path) ?? null) ? uid : null;
  });

// ── on macOS ────────────────────────────────────────────────────────────

/** The asking socket, as macOS's TCP table lists it. */
export interface DarwinSocket {
  /** Who created it (the kernel's so_uid, as Linux's /proc/net/tcp uid). */
  readonly uid: number;
  /** The process that last used it, and the one it is delegated to (the same unless delegated). */
  readonly pid: number;
  readonly ePid: number;
}

// XNU's records in net.inet.tcp.pcblist_n (bsd/sys/socketvar.h, bsd/netinet/in_pcb.h,
// bsd/netinet/tcp_var.h; packed to 4 bytes): each socket is a run of records, each
// starting with its length and kind, framed by an xinpgen (24 bytes) at both ends.
const XINPGEN = 24;
const XSO_SOCKET = 0x1;
const XSO_INPCB = 0x10;
const XSO_TCPCB = 0x20;
const INP_IPV4 = 0x1;
const INP_IPV6 = 0x2;
const TCPS_ESTABLISHED = 4;

/** Whether the 16 bytes of an in_addr_4in6 / in6_addr are a loopback address. */
const loopback = (bytes: Uint8Array, vflag: number) => {
  if ((vflag & INP_IPV4) !== 0) return bytes[12] === 127;
  if ((vflag & INP_IPV6) === 0) return false;
  const zeros = (from: number, to: number) => bytes.subarray(from, to).every((b) => b === 0);
  if (zeros(0, 15) && bytes[15] === 1) return true; // ::1
  return zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff && bytes[12] === 127; // ::ffff:127.x
};

/**
 * The asking end of `connection` in macOS's TCP table (`sysctl -b
 * net.inet.tcp.pcblist_n`, raw): an established socket on loopback whose
 * local port is the connection's remote port, talking to the relay's port on
 * loopback. Null when there is none, or more than one, or the table does not
 * read as XNU writes it.
 */
export const darwinSocket = (table: Uint8Array, connection: Connection): DarwinSocket | null => {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const u32 = (at: number) => view.getUint32(at, true);
  const step = (length: number) => (length + 7) & ~7;
  if (table.byteLength < XINPGEN || u32(0) !== XINPGEN) return null;
  interface Pcb {
    lport: number;
    fport: number;
    loopback: boolean;
    socket?: DarwinSocket;
    state?: number;
  }
  const pcbs: Array<Pcb> = [];
  let pcb: Pcb | null = null;
  let at = step(XINPGEN);
  let closed = false;
  while (at + 8 <= table.byteLength) {
    const length = u32(at);
    // The closing xinpgen, after the last socket.
    if (length <= XINPGEN) {
      closed = true;
      break;
    }
    if (at + length > table.byteLength) return null;
    const kind = u32(at + 4);
    if (kind === XSO_INPCB && length >= 80) {
      const vflag = table[at + 44] ?? 0;
      pcb = {
        fport: view.getUint16(at + 16, false),
        lport: view.getUint16(at + 18, false),
        loopback:
          loopback(table.subarray(at + 48, at + 64), vflag) &&
          loopback(table.subarray(at + 64, at + 80), vflag),
      };
      pcbs.push(pcb);
    } else if (kind === XSO_SOCKET && length >= 76 && pcb !== null)
      pcb.socket = {
        uid: u32(at + 64),
        pid: view.getInt32(at + 68, true),
        ePid: view.getInt32(at + 72, true),
      };
    else if (kind === XSO_TCPCB && length >= 40 && pcb !== null)
      pcb.state = view.getInt32(at + 36, true);
    at += step(length);
  }
  if (!closed) return null;
  const asking = pcbs.filter(
    (p) =>
      p.loopback &&
      p.lport === connection.remotePort &&
      p.fport === connection.localPort &&
      p.state === TCPS_ESTABLISHED,
  );
  const [only] = asking;
  return asking.length === 1 && only?.socket !== undefined ? only.socket : null;
};

/**
 * Tailscale's App Store network extension, as Apple signed it for the Mac App
 * Store (or, the form Tailscale's own app's requirement allows, a Developer ID
 * build of Tailscale's team). Its bundle id is the one Tailscale's source
 * names (version/prop.go).
 */
export const APP_STORE_EXTENSION =
  'anchor apple generic and identifier "io.tailscale.ipn.macos.network-extension" and (certificate leaf[field.1.2.840.113635.100.6.1.9] exists or certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "W5364U7YZB")';

/** What the macOS check reads: commands in practice, fakes in tests. */
export interface DarwinLookup {
  /** The kernel's TCP table, raw; null when it could not be read. */
  readonly table: Effect.Effect<Uint8Array | null, never, ChildProcessSpawner.ChildProcessSpawner>;
  /** Whether running process `pid` is Tailscale's App Store network extension, by its code signature. */
  readonly appStoreExtension: (
    pid: number,
  ) => Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner>;
}

/** `sysctl -b net.inet.tcp.pcblist_n`, as bytes: a few ms, and no root needed. */
const tcpTable = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("/usr/sbin/sysctl", ["-b", "net.inet.tcp.pcblist_n"], {
          stdin: "ignore",
        }),
      );
      const [chunks, code] = yield* Effect.all(
        [
          Stream.runFold(
            child.stdout,
            (): Array<Uint8Array> => [],
            (all, c) => {
              all.push(c);
              return all;
            },
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (Number(code) !== 0) return null;
      const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
      let at = 0;
      for (const c of chunks) {
        bytes.set(c, at);
        at += c.byteLength;
      }
      return bytes;
    }),
  );
}).pipe(
  Effect.timeoutOption(Duration.seconds(10)),
  Effect.map((table) => (table._tag === "Some" ? table.value : null)),
  Effect.orElseSucceed(() => null),
);

export const liveDarwinLookup: DarwinLookup = {
  table: tcpTable,
  // codesign checks the running process's signature (not a file someone could swap
  // after launch); exit 0 only when it satisfies the requirement.
  appStoreExtension: (pid) =>
    exec({
      command: "/usr/bin/codesign",
      args: ["--verify", `-R=${APP_STORE_EXTENSION}`, String(pid)],
      timeout: Duration.seconds(10),
    }).pipe(Effect.map((r) => r.code === 0)),
};

/**
 * Whether tailscaled made `connection`, on macOS: the asking socket is root's,
 * or its process is Tailscale's App Store network extension. Unknown is no.
 */
const servedOnDarwin = (connection: Connection, lookup: DarwinLookup) =>
  Effect.gen(function* () {
    const table = yield* lookup.table;
    const socket = table === null ? null : darwinSocket(table, connection);
    if (socket === null) return "Who connected could not be told.";
    if (socket.uid === 0) return null;
    for (const pid of new Set([socket.pid, socket.ePid]))
      if (pid > 0 && (yield* lookup.appStoreExtension(pid))) return null;
    return "This request did not come through tailscale serve: another program on the hub made it.";
  });

/** Why a hub on `platform` cannot serve the app at all; null when it can. */
export const unservedPlatform = (platform: string): string | null =>
  platform === "linux" || platform === "darwin"
    ? null
    : "This hub cannot tell tailscale serve from another program on it (only a Linux or macOS hub can), so its app opens for no one. Open the app on your computer with t3-fleet ui --local.";

/**
 * Whether tailscaled made `connection`: on Linux, the asking socket is root's,
 * or that of the user an installed tailscaled runs as under systemd
 * (tailscaledUser); on macOS, see servedOnDarwin. Null when it did; why not,
 * otherwise.
 */
export const servedByTailscale = (
  connection: Connection | null,
  platform: string = process.platform,
  proc = "/proc",
  darwin: DarwinLookup = liveDarwinLookup,
  linux: LinuxLookup = liveLinuxLookup,
) =>
  Effect.gen(function* () {
    const unserved = unservedPlatform(platform);
    if (unserved !== null) return unserved;
    if (connection === null) return "Who connected could not be told.";
    if (platform === "darwin") return yield* servedOnDarwin(connection, darwin);
    const fs = yield* FileSystem.FileSystem;
    const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    let owner: number | null = null;
    for (const table of ["net/tcp", "net/tcp6"]) {
      owner = socketOwner(yield* read(`${proc}/${table}`), connection);
      if (owner !== null) break;
    }
    if (owner === null) return "Who connected could not be told.";
    if (owner === 0) return null;
    if ((yield* tailscaledUser(proc, linux)) === owner) return null;
    return "This request did not come through tailscale serve: another program on the hub made it.";
  });
