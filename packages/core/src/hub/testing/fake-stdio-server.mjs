// A tiny stdio MCP server for the hub's tests. One JSON-RPC message per line.
//   tools/call "echo"      answers { text } after `delayMs`, with progress first
//                          when the request carries a progressToken
//   tools/call "notify"    makes the server send notifications/tools/list_changed
//   tools/call "crash"     exits the process
//   tools/call "ping_me"   pings the client, and answers with what came back
//   tools/call "cancelled" answers with the request ids cancelled so far
// With --null-tools, tools/list answers { "tools": null }; with --silent-tools,
// it never answers tools/list at all.
import { createInterface } from "node:readline";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let initializeCount = 0;
const cancelled = [];
let pinging = null;

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "notifications/cancelled") cancelled.push(m.params.requestId);
  if (m.id === "srv-ping" && m.method === undefined && pinging !== null) {
    send({ jsonrpc: "2.0", id: pinging, result: { content: [{ type: "text", text: `pong ${JSON.stringify(m.result ?? m.error)}` }] } });
    pinging = null;
    return;
  }
  if (m.id === undefined) return;
  if (m.method === "initialize") {
    initializeCount++;
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1" } } });
  }
  if (m.method === "ping") return send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "tools/list") {
    if (process.argv.includes("--silent-tools")) return;
    if (process.argv.includes("--null-tools")) return send({ jsonrpc: "2.0", id: m.id, result: { tools: null } });
    return send({ jsonrpc: "2.0", id: m.id, result: { tools: ["echo", "notify", "crash", "delete_all"].map((name) => ({ name, inputSchema: { type: "object" } })) } });
  }
  if (m.method === "tools/call") {
    const { name, arguments: args = {} } = m.params;
    if (name === "crash") process.exit(3);
    if (name === "notify") {
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "notified" }] } });
    }
    if (name === "ping_me") {
      pinging = m.id;
      return send({ jsonrpc: "2.0", id: "srv-ping", method: "ping" });
    }
    if (name === "cancelled") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify(cancelled) }] } });
    const token = m.params._meta?.progressToken;
    if (token !== undefined) send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1 } });
    if (args.log) send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: `working on ${args.text}` } });
    setTimeout(
      () => send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `${args.text} (init ${initializeCount})` }] } }),
      args.delayMs ?? 0,
    );
    return;
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unknown method" } });
});
