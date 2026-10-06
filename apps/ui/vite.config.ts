import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";

import { fixtureEvents, fixtureResponse, followSetup } from "./dev/fixtures.ts";

/**
 * `vp dev` proxies /api to a running `t3-fleet ui --port 8397` (or
 * T3_FLEET_UI_PORT); open the dev server with the `#ticket=…` it printed.
 * With T3_FLEET_UI_FIXTURES=1 it answers /api itself from dev/fixtures.ts
 * instead, so every view, the hub's and the models' too, can be worked on
 * without a fleet; open it at /#ticket=f (the fixtures take any ticket).
 * The setup wizard is at /?setup=fresh#ticket=f; dev/setup-fixtures.ts lists
 * its other variants.
 */
const fixtures = (): Plugin => ({
  name: "t3-fleet-ui-fixtures",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", "http://dev");
      if (!url.pathname.startsWith("/api/")) return next();
      // The variant is the asking page's query string.
      const page = new URL(req.headers.referer ?? "http://dev/").searchParams;
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        const answer = fixtureResponse(req.method ?? "GET", url.pathname, body, page);
        if (answer === "events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write(fixtureEvents);
          const stop = followSetup(page, (chunk) => res.write(chunk));
          // The response closes when the page goes; the request closes once read.
          res.on("close", stop);
          return;
        }
        setTimeout(() => {
          res.writeHead(answer.status, {
            "content-type":
              answer.body === "" || answer.status >= 400 ? "text/plain" : "application/json",
            ...answer.headers,
          });
          res.end(answer.body);
        }, answer.delay ?? 0);
      });
    });
  },
});

const target = `http://127.0.0.1:${process.env["T3_FLEET_UI_PORT"] ?? "8397"}`;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(process.env["T3_FLEET_UI_FIXTURES"] === "1" ? [fixtures()] : []),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Everything ships inside the T3 Fleet bundle; no source maps there.
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        // t3-fleet ui refuses foreign origins; the dev server is one.
        configure: (proxy) => proxy.on("proxyReq", (request) => request.removeHeader("origin")),
      },
    },
  },
});
