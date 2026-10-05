// Stands in for `tailscale serve` (real Tailscale does not run in these containers). It does what
// serve does for the relay's port: listens on this machine's own address (not loopback), forwards
// to the relay on 127.0.0.1:8399 with the browser's Host kept, removes every Tailscale-* header the
// client sent, and sets Tailscale-User-Login to who is asking. Real serve learns that from the
// tailnet; here it is looked up by source address: node serve-proxy.mjs <bind address> ip=login,...
// A source with no login stands for a tagged device: no identity header at all.
import http from "node:http";

const [bind, pairs = ""] = process.argv.slice(2);
const logins = new Map(
  pairs
    .split(",")
    .filter(Boolean)
    .map((p) => p.split("=")),
);

http
  .createServer((req, res) => {
    const headers = { ...req.headers };
    for (const name of Object.keys(headers))
      if (name.startsWith("tailscale-")) delete headers[name];
    const source = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const login = logins.get(source);
    if (login !== undefined) headers["tailscale-user-login"] = login;
    headers["x-forwarded-for"] = source;
    const upstream = http.request(
      { host: "127.0.0.1", port: 8399, method: req.method, path: req.url, headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(upstream);
  })
  .listen(8399, bind);
