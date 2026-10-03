import { defineConfig, mergeConfig } from "vite-plus";

import baseConfig from "../../vite.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    pack: {
      // One self-contained file: the controller streams it over ssh into
      // `node -` on machines that have nothing installed, so every
      // dependency is inlined.
      entry: ["src/bin.ts"],
      outDir: "dist",
      clean: true,
      platform: "node",
      deps: { alwaysBundle: () => true, onlyBundle: false },
    },
  }),
);
