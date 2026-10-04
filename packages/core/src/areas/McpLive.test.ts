// A plain HTTP server stands in for an MCP endpoint.
// @effect-diagnostics nodeBuiltinImport:off
import { createServer } from "node:http";

import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
import { expect, it } from "vite-plus/test";

import { liveCheck } from "./Mcp.ts";

it("the live check closes the session its initialize opened", async () => {
  const deleted: Array<{ session: string | undefined; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    if (req.method === "DELETE") {
      deleted.push({ session: req.headers["mcp-session-id"] as string | undefined, authorization: req.headers.authorization });
      res.writeHead(204).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" });
      res.end('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"s","version":"1"}}}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const result = await Effect.runPromise(liveCheck(`http://127.0.0.1:${port}/mcp`, "secret").pipe(Effect.provide(FetchHttpClient.layer)));
    expect(result).toBe("ok");
    expect(deleted).toEqual([{ session: "session-1", authorization: "Bearer secret" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
