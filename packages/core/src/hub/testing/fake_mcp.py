# A tiny MCP server for the hub's Docker tests, in the python:3-alpine image.
# "http": streamable HTTP on :8080/mcp.  "stdio": one JSON-RPC message per line.
import json, sys

def answer(m):
    if "id" not in m:
        return None
    if m.get("method") == "initialize":
        result = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "py", "version": "1"}}
    elif m.get("method") == "tools/list":
        result = {"tools": [{"name": "hello", "inputSchema": {"type": "object"}}]}
    else:
        result = {"content": [{"type": "text", "text": "hello from docker"}]}
    return {"jsonrpc": "2.0", "id": m["id"], "result": result}

if sys.argv[1] == "stdio":
    for line in sys.stdin:
        reply = answer(json.loads(line))
        if reply is not None:
            print(json.dumps(reply), flush=True)
else:
    from http.server import BaseHTTPRequestHandler, HTTPServer
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", 0)))
            reply = answer(json.loads(body))
            if reply is None:
                self.send_response(202); self.end_headers(); return
            data = json.dumps(reply).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        def do_DELETE(self):
            self.send_response(204); self.end_headers()
        def log_message(self, *args):
            pass
    HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
