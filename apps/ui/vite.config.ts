import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite-plus";

import { fixtureResponse } from "./dev/fixtures.ts";

/**
 * `vp dev` proxies /api to a running `fleetx ui` (port 8397, or
 * FLEETX_UI_PORT). With FLEETX_UI_FIXTURES=1 it answers /api itself from
 * dev/fixtures.ts instead, so every view, the hub's and the models' too, can
 * be worked on without a fleet.
 */
const fixtures = (): Plugin => ({
  name: "fleetx-ui-fixtures",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = new URL(req.url ?? "/", "http://dev");
      if (!url.pathname.startsWith("/api/")) return next();
      const answer = fixtureResponse(req.method ?? "GET", url.pathname);
      if (answer === "events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(": connected\n\n");
        return;
      }
      res.writeHead(answer.status, { "content-type": answer.body === "" ? "text/plain" : "application/json" });
      res.end(answer.body);
    });
  },
});

const target = `http://127.0.0.1:${process.env["FLEETX_UI_PORT"] ?? "8397"}`;

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(process.env["FLEETX_UI_FIXTURES"] === "1" ? [fixtures()] : [])],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Everything ships inside the fleetx bundle; no source maps there.
    sourcemap: false,
  },
  server: {
    proxy: {
      "/api": {
        target,
        changeOrigin: true,
        // fleetx ui refuses foreign origins; the dev server is one.
        configure: (proxy) => proxy.on("proxyReq", (request) => request.removeHeader("origin")),
      },
    },
  },
});
