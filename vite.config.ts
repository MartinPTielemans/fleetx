import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // T3 Code's formatter settings (its defaults, printWidth 100), so these packages
  // read the same once they move into its monorepo. The vendored copy keeps T3's own layout.
  fmt: {
    ignorePatterns: ["dist", "node_modules", "pnpm-lock.yaml", "*.tsbuildinfo", "packages/core/src/vendor/**"],
    sortPackageJson: {},
  },
  test: {
    include: ["**/*.test.ts"],
  },
});
