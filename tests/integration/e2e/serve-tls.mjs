// Stands in for `tailscale serve --https=8399` on the hub, run as root as tailscaled is: TLS on the
// hub's own address (a certificate for hub.tailnet.ts.net from a throwaway CA), forwarded to the
// relay on 127.0.0.1:8399 with the Host kept. It removes every Tailscale-* header a client sent and
// sets Tailscale-User-Login by the source address (/etc/wizfe/logins: "ip=login" lines). It answers
// 502 until the relay is up, as serve does.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const [bind, cert, key] = process.argv.slice(2);
const logins = () =>
  new Map(
    fs
      .readFileSync("/etc/wizfe/logins", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => l.trim().split("=")),
  );
https
  .createServer({ cert: fs.readFileSync(cert), key: fs.readFileSync(key) }, (req, res) => {
    const headers = { ...req.headers };
    for (const name of Object.keys(headers))
      if (name.startsWith("tailscale-")) delete headers[name];
    const source = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const login = logins().get(source);
    if (login !== undefined) headers["tailscale-user-login"] = login;
    const up = http.request(
      { host: "127.0.0.1", port: 8399, method: req.method, path: req.url, headers },
      (a) => {
        res.writeHead(a.statusCode ?? 502, a.headers);
        a.pipe(res);
      },
    );
    up.on("error", (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(up);
  })
  .listen(8399, bind);
