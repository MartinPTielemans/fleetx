// Build configuration runs in Node, outside the Effect rules.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

const MIME: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  json: "application/json",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
};

/**
 * The built app (apps/ui/dist), one gzipped base64 string per file, as a
 * JSON string literal that `define` puts in place of __FLEETX_UI_ASSETS__ in
 * src/ui.ts. Absent when the app has not been built; `build` builds it first.
 */
const uiAssets = (): string | undefined => {
  const dist = new URL("../ui/dist", import.meta.url).pathname;
  if (!existsSync(join(dist, "index.html"))) return undefined;
  const files: Record<string, { type: string; gz: string }> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const path = `/${relative(dist, full).split(sep).join("/")}`;
        const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
        files[path] = { type: MIME[ext] ?? "application/octet-stream", gz: gzipSync(readFileSync(full), { level: 9 }).toString("base64") };
      }
    }
  };
  walk(dist);
  return JSON.stringify(JSON.stringify(files));
};

const assets = uiAssets();

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      // One self-contained file: the controller streams it over ssh into
      // `node -` on machines that have nothing installed, so every
      // dependency is inlined, and so is the UI.
      entry: ["src/bin.ts"],
      outDir: "dist",
      clean: true,
      platform: "node",
      deps: { alwaysBundle: () => true, onlyBundle: false },
      ...(assets === undefined ? {} : { define: { __FLEETX_UI_ASSETS__: assets } }),
    },
  }),
);
