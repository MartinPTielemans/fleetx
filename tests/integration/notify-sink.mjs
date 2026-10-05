// Local ntfy-compatible HTTP sink. Never forwards to a real topic.
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const received = [];
createServer((req, res) => {
  if (req.method === "GET") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(received));
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    if (req.url === "/reject") {
      res.writeHead(403);
      res.end("rejected");
      return;
    }
    received.push({
      body,
      title: req.headers.title,
      tags: req.headers.tags,
      priority: req.headers.priority,
    });
    writeFileSync("/tmp/requests.json", JSON.stringify(received));
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
}).listen(8080, "0.0.0.0");
