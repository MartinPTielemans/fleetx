// A plain HTTP server stands in for an MCP endpoint.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, it } from "vite-plus/test";

import { request } from "./McpClient.ts";

type Handler = (
  body: { id?: number; method: string; params?: unknown },
  req: IncomingMessage,
  res: ServerResponse,
) => void;

const withServer = async (handler: Handler, run: (url: string) => Promise<void>) => {
  const server = createServer((req, res) => {
    let text = "";
    req.on("data", (c: Buffer) => (text += c.toString()));
    req.on("end", () => {
      if (req.method === "DELETE") return void res.writeHead(204).end();
      handler(JSON.parse(text), req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    await run(`http://127.0.0.1:${port}/mcp`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
};

const send = (target: { url: string; headers: Record<string, string> }, method: string) =>
  Effect.runPromise(
    request(target, method, {}).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.match({ onFailure: (failure) => ({ failure }), onSuccess: (value) => ({ value }) }),
    ),
  );

it("initializes, sends the request in the same session, and reads an SSE answer", async () => {
  const seen: Array<{
    method: string;
    session: string | undefined;
    authorization: string | undefined;
  }> = [];
  await withServer(
    (body, req, res) => {
      seen.push({
        method: body.method,
        session: req.headers["mcp-session-id"] as string | undefined,
        authorization: req.headers.authorization,
      });
      if (body.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
        return void res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { capabilities: {} } }),
        );
      }
      if (body.id === undefined) return void res.writeHead(202).end();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "t" }] } })}\n\n`,
      );
    },
    async (url) => {
      const result = await send({ url, headers: { authorization: "Bearer k" } }, "tools/list");
      expect(result).toEqual({ value: { tools: [{ name: "t" }] } });
    },
  );
  expect(seen).toEqual([
    { method: "initialize", session: undefined, authorization: "Bearer k" },
    { method: "notifications/initialized", session: "s1", authorization: "Bearer k" },
    { method: "tools/list", session: "s1", authorization: "Bearer k" },
  ]);
});

it("reports a JSON-RPC error and an HTTP error as sentences", async () => {
  await withServer(
    (body, _req, res) => {
      if (body.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
      }
      if (body.id === undefined) return void res.writeHead(202).end();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          error: { code: -32602, message: 'unknown tool "x"' },
        }),
      );
    },
    async (url) => {
      expect(await send({ url, headers: {} }, "tools/call")).toEqual({
        failure: 'tools/call: unknown tool "x"',
      });
    },
  );
  await withServer(
    (_body, _req, res) => void res.writeHead(503).end("too many sessions"),
    async (url) => {
      expect(await send({ url, headers: {} }, "tools/list")).toEqual({
        failure: "HTTP 503: too many sessions",
      });
    },
  );
});
