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
 * What it cannot tell apart: another process on the hub itself that connects
 * to the loopback port and sets the headers. Such a process already runs where
 * the relay token is; see docs/topologies.md for what that means.
 *
 * Passing the gate is not a session: the app still trades it for a token,
 * bound to that login, which every /api request sends as a header (UiServer.ts).
 */
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
