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
 *   connection                connect and set the headers itself. On Linux the
 *                             kernel says whose socket the other end of the
 *                             connection is (/proc/net/tcp): it must be root's
 *                             or the user tailscaled runs as. A program run by
 *                             anyone else, the relay's own user included, is
 *                             refused (servedByTailscale)
 *
 * Why not a Unix socket for tailscale serve to proxy to, which only the
 * relay's user could open: since Tailscale 1.98.9 (TS-2026-005) only root may
 * set a Unix socket as a Serve target, and the relay sets its Serve up
 * unattended, as its own user. Why not Tailscale's whois: the connection
 * reaching the relay is tailscaled's own, from 127.0.0.1, and a forged
 * request can name any device's address in a header.
 *
 * What remains: root on the hub (or the user tailscaled runs as, when that is
 * not root) can pose as any login; it can read every secret there anyway. A
 * hub that is not Linux cannot tell its connections apart, so its app refuses
 * everyone; `t3-fleet ui --local` on an authority serves the app there.
 *
 * Passing the gate is not a session: the app still trades it for a token,
 * bound to that login, which every /api request sends as a header (UiServer.ts).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

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

/** The real uid in a /proc/<pid>/status text, when it is tailscaled's. */
export const tailscaledUid = (status: string): number | null => {
  if (!/^Name:\s*tailscaled\s*$/m.test(status)) return null;
  const uid = /^Uid:\s*(\d+)/m.exec(status)?.[1];
  return uid === undefined ? null : Number(uid);
};

/**
 * Whether tailscaled made `connection`, on Linux: the asking socket is root's,
 * or the user tailscaled runs as. Null when it did; why not, otherwise.
 */
export const servedByTailscale = (
  connection: Connection | null,
  platform: string = process.platform,
  proc = "/proc",
) =>
  Effect.gen(function* () {
    if (platform !== "linux")
      return "This hub cannot tell tailscale serve from another program on it (only a Linux hub can), so its app opens for no one. Open the app on your computer with t3-fleet ui --local.";
    if (connection === null) return "Who connected could not be told.";
    const fs = yield* FileSystem.FileSystem;
    const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    let owner: number | null = null;
    for (const table of ["net/tcp", "net/tcp6"]) {
      owner = socketOwner(yield* read(`${proc}/${table}`), connection);
      if (owner !== null) break;
    }
    if (owner === null) return "Who connected could not be told.";
    if (owner === 0) return null;
    const pids = (yield* fs
      .readDirectory(proc)
      .pipe(Effect.orElseSucceed(() => [] as Array<string>))).filter((p) => /^\d+$/.test(p));
    for (const pid of pids) {
      const uid = tailscaledUid(yield* read(`${proc}/${pid}/status`));
      if (uid === owner) return null;
    }
    return "This request did not come through tailscale serve: another program on the hub made it.";
  });
