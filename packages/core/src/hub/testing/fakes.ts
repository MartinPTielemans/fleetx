/**
 * Fakes for the hub's tests: an OAuth authorization server and an MCP server
 * protected by it, as plain Node HTTP servers on random local ports.
 */
// Test fakes are plain HTTP servers; nothing here runs inside an Effect.
// @effect-diagnostics nodeBuiltinImport:off globalRandom:off preferSchemaOverJson:off globalTimers:off
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const body = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = "";
    req.on("data", (c: Buffer) => (text += c.toString("utf8")));
    req.on("end", () => resolve(text));
  });

const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void) =>
  new Promise<{ server: Server; url: string }>((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`,
      });
    });
  });

const send = (
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof value === "string" ? value : JSON.stringify(value));
};

export interface FakeAuthServer {
  readonly url: string;
  readonly refreshes: () => number;
  /** Every POST to the token endpoint, whatever it carried. */
  readonly tokenPosts: () => number;
  readonly registrations: () => number;
  /** The last token request's form fields (for asserting resource, verifier, …). */
  readonly lastTokenRequest: () => URLSearchParams | null;
  /** Approve an authorization URL as a person would: returns the code the browser would carry back. */
  readonly approve: (authorizationUrl: string) => string;
  readonly setExpiresIn: (seconds: number) => void;
  readonly refuseRefresh: (refuse: boolean) => void;
  /** Answer refreshes with this status and body instead (429, 503, …); null to stop. */
  readonly failRefresh: (
    failure: { readonly status: number; readonly body: unknown } | null,
  ) => void;
  /** Rotate the refresh token, then wait this long before answering a refresh. */
  readonly delayRefresh: (ms: number) => void;
  /** Forget every registered client, as some providers do: their token requests get invalid_client. */
  readonly forgetClients: () => void;
  readonly isValid: (token: string) => boolean;
  readonly revokeAccessTokens: () => void;
  readonly close: () => Promise<void>;
}

export const fakeAuthServer = async (options: {
  readonly openIdOnly: boolean;
  readonly expectedResource: () => string;
  /** Lie about the issuer in the metadata. */
  readonly issuer?: string;
}): Promise<FakeAuthServer> => {
  let refreshes = 0;
  let registrations = 0;
  let expiresIn = 3600;
  let refuse = false;
  let failure: { readonly status: number; readonly body: unknown } | null = null;
  let delay = 0;
  let forgotten = false;
  let counter = 0;
  let last: URLSearchParams | null = null;
  const clients = new Map<string, Array<string>>();
  const codes = new Map<
    string,
    { challenge: string; redirectUri: string; clientId: string; resource: string }
  >();
  const access = new Set<string>();
  const refresh = new Set<string>();
  const issue = () => {
    counter++;
    const tokens = {
      access_token: `at-${counter}`,
      refresh_token: `rt-${counter}`,
      token_type: "Bearer",
      expires_in: expiresIn,
    };
    access.add(tokens.access_token);
    refresh.add(tokens.refresh_token);
    return tokens;
  };
  let base = "";
  let tokenPosts = 0;
  const metadata = () => ({
    issuer: options.issuer ?? base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
  const { server, url } = await listen(async (req, res) => {
    const path = new URL(req.url ?? "/", base).pathname;
    if (req.method === "GET" && path === "/.well-known/oauth-authorization-server")
      return options.openIdOnly ? send(res, 404, {}) : send(res, 200, metadata());
    if (req.method === "GET" && path === "/.well-known/openid-configuration")
      return send(res, 200, metadata());
    if (req.method === "POST" && path === "/register") {
      const r = JSON.parse(await body(req)) as { redirect_uris: Array<string> };
      registrations++;
      const id = `client-${registrations}`;
      clients.set(id, r.redirect_uris);
      return send(res, 201, {
        client_id: id,
        redirect_uris: r.redirect_uris,
        token_endpoint_auth_method: "none",
      });
    }
    if (req.method === "POST" && path === "/token") {
      tokenPosts++;
      const form = new URLSearchParams(await body(req));
      last = form;
      if (form.get("resource") !== options.expectedResource())
        return send(res, 400, { error: "invalid_target" });
      if (forgotten && !clients.has(form.get("client_id") ?? ""))
        return send(res, 401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        const code = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (
          code === undefined ||
          code.challenge !== challenge ||
          code.redirectUri !== form.get("redirect_uri") ||
          code.clientId !== form.get("client_id")
        ) {
          return send(res, 400, { error: "invalid_grant" });
        }
        return send(res, 200, issue());
      }
      if (form.get("grant_type") === "refresh_token") {
        refreshes++;
        if (failure !== null) return send(res, failure.status, failure.body);
        const rt = form.get("refresh_token") ?? "";
        if (refuse || !refresh.has(rt))
          return send(res, 400, {
            error: "invalid_grant",
            error_description: "refresh token revoked",
          });
        refresh.delete(rt); // rotation: each refresh token works once
        const tokens = issue();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        return send(res, 200, tokens);
      }
      return send(res, 400, { error: "unsupported_grant_type" });
    }
    send(res, 404, {});
  });
  base = url;
  return {
    url,
    refreshes: () => refreshes,
    tokenPosts: () => tokenPosts,
    registrations: () => registrations,
    lastTokenRequest: () => last,
    approve: (authorizationUrl) => {
      const u = new URL(authorizationUrl);
      const p = u.searchParams;
      if (u.origin + u.pathname !== `${base}/authorize`)
        throw new Error(`unexpected authorization endpoint ${u.toString()}`);
      if (p.get("code_challenge_method") !== "S256" || p.get("response_type") !== "code")
        throw new Error("not PKCE S256 code flow");
      const redirectUri = p.get("redirect_uri") ?? "";
      if (!(clients.get(p.get("client_id") ?? "") ?? []).includes(redirectUri))
        throw new Error("redirect_uri not registered");
      const code = `code-${codes.size + 1}-${Math.random().toString(36).slice(2)}`;
      codes.set(code, {
        challenge: p.get("code_challenge") ?? "",
        redirectUri,
        clientId: p.get("client_id") ?? "",
        resource: p.get("resource") ?? "",
      });
      return code;
    },
    setExpiresIn: (s) => {
      expiresIn = s;
    },
    refuseRefresh: (r) => {
      refuse = r;
    },
    failRefresh: (f) => {
      failure = f;
    },
    delayRefresh: (ms) => {
      delay = ms;
    },
    forgetClients: () => {
      clients.clear();
      forgotten = true;
    },
    isValid: (token) => access.has(token),
    revokeAccessTokens: () => access.clear(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

export interface FakeMcpServer {
  readonly url: string;
  /** Requests for the resource metadata: at the well-known path, and at the path the 401 names. */
  readonly metadataHits: () => { readonly wellKnown: number; readonly hinted: number };
  /** The last request body the server received, exactly as sent. */
  readonly lastBody: () => string;
  /** Every bearer token the server was sent, accepted or not. */
  readonly bearers: () => ReadonlyArray<string>;
  readonly close: () => Promise<void>;
}

/** A streamable-HTTP MCP server at /mcp that needs a bearer token `isValid` accepts. */
export const fakeProtectedMcp = async (
  authServer: () => string,
  isValid: (token: string) => boolean,
  options: { readonly resource?: string; readonly hint?: string } = {},
): Promise<FakeMcpServer> => {
  let base = "";
  const hits = { wellKnown: 0, hinted: 0 };
  let last = "";
  const bearers: Array<string> = [];
  const { server, url } = await listen(async (req, res) => {
    const path = new URL(req.url ?? "/", base).pathname;
    if (
      req.method === "GET" &&
      (path === "/.well-known/oauth-protected-resource/mcp" || path === "/meta/resource")
    ) {
      if (path === "/meta/resource") hits.hinted++;
      else hits.wellKnown++;
      return send(res, 200, {
        resource: options.resource ?? `${base}/mcp`,
        authorization_servers: [authServer()],
        scopes_supported: ["mcp"],
      });
    }
    if (path !== "/mcp") return send(res, 404, {});
    const token = /^Bearer (.+)$/.exec(req.headers["authorization"] ?? "")?.[1] ?? "";
    if (token !== "") bearers.push(token);
    if (!isValid(token)) {
      return send(
        res,
        401,
        { error: "invalid_token" },
        {
          "www-authenticate": `Bearer error="invalid_token", resource_metadata="${options.hint ?? `${base}/meta/resource`}"`,
        },
      );
    }
    if (req.method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    const text = await body(req);
    last = text;
    const m = JSON.parse(text) as {
      id?: number | string;
      method: string;
      params?: { name?: string };
    };
    if (m.id === undefined) {
      res.writeHead(202);
      return res.end();
    }
    const result =
      m.method === "initialize"
        ? {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "protected", version: "1" },
          }
        : m.method === "tools/list"
          ? {
              tools: [
                { name: "search", inputSchema: { type: "object" } },
                { name: "drop_table", inputSchema: { type: "object" } },
              ],
            }
          : { content: [{ type: "text", text: `called ${m.params?.name ?? "?"}` }] };
    // Answer as SSE, as many servers do.
    res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "s-1" });
    res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
  });
  base = url;
  return {
    url,
    metadataHits: () => ({ ...hits }),
    lastBody: () => last,
    bearers: () => [...bearers],
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};
