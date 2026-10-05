// A fake ntfy.sh: TLS with a certificate for ntfy.sh from the throwaway CA. Every node maps ntfy.sh
// to it in /etc/hosts, so nothing reaches the real service. GET /__requests lists what came.
import fs from "node:fs";
import https from "node:https";

const received = [];
https
  .createServer(
    { cert: fs.readFileSync("/certs/ntfy.pem"), key: fs.readFileSync("/certs/ntfy.key") },
    (req, res) => {
      if (req.method === "GET" && req.url === "/__requests") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify(received));
      }
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({
          at: new Date().toISOString(),
          path: req.url,
          title: req.headers.title,
          priority: req.headers.priority,
          body,
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: String(received.length), event: "message" }));
      });
    },
  )
  .listen(443, "0.0.0.0");
