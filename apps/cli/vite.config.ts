// Build configuration runs in Node, outside the Effect rules.
import { execFileSync } from "node:child_process";
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
 * JSON string literal that `define` puts in place of __T3_FLEET_UI_ASSETS__ in
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

/**
 * This build's identity, which Build.ts reads back out of any bundle's text:
 * the version, the time of the build, and the commit (with -dirty for
 * uncommitted changes). The marker format is Build.ts's buildMarker.
 */
const buildMarker = (): string => {
  const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { version: string };
  const git = (...args: Array<string>) => {
    try {
      return execFileSync("git", args, { cwd: new URL(".", import.meta.url), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const commit = git("rev-parse", "--short=12", "HEAD");
  const dirty = commit !== "" && git("status", "--porcelain", "--untracked-files=no") !== "" ? "-dirty" : "";
  // SOURCE_DATE_EPOCH makes the build reproducible (Nix sets it).
  const epoch = process.env["SOURCE_DATE_EPOCH"];
  const builtAt = epoch !== undefined && /^\d+$/.test(epoch) ? Number(epoch) * 1000 : Date.now();
  return `t3-fleet-build:${pkg.version}:${builtAt}:${commit}${dirty}`;
};

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      // One self-contained file: the controller streams it over ssh into
      // `node -` on machines that have nothing installed, so every
      // dependency is inlined, and so is the UI. Minified, since every
      // check sends it to every machine that does not have it yet.
      entry: ["src/bin.ts"],
      outDir: "dist",
      clean: true,
      platform: "node",
      minify: true,
      deps: { alwaysBundle: () => true, onlyBundle: false },
      define: {
        __T3_FLEET_BUILD__: JSON.stringify(buildMarker()),
        ...(assets === undefined ? {} : { __T3_FLEET_UI_ASSETS__: assets }),
      },
    },
  }),
);
