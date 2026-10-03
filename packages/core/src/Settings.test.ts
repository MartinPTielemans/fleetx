import { describe, expect, it } from "vite-plus/test";

import { DotfilesArea } from "./areas/Dotfiles.ts";
import { describeMerged, mergeLayers } from "./Settings.ts";

describe("mergeLayers", () => {
  const merged = mergeLayers([
    { source: "defaults", table: { t3: { channel: "stable" }, skills: { ignore: ["a", "b"], store: "~/s" } } },
    { source: "profile workstation", table: { t3: { channel: "nightly" }, skills: { "ignore.add": ["c", "a"] } } },
    { source: "node laptop", table: { skills: { "ignore.remove": ["b"] }, dotfiles: [{ src: "x", dest: "~/.x" }] } },
  ]);

  it("merges tables key by key, later layers winning", () => {
    expect(merged.table).toEqual({
      t3: { channel: "nightly" },
      skills: { ignore: ["a", "c"], store: "~/s" },
      dotfiles: [{ src: "x", dest: "~/.x" }],
    });
  });

  it("records which layer set each value", () => {
    const rows = Object.fromEntries(describeMerged(merged).map((r) => [r.path, r.source]));
    expect(rows["t3.channel"]).toBe("profile workstation");
    expect(rows["skills.store"]).toBe("defaults");
    expect(rows["skills.ignore"]).toBe("node laptop (remove)");
    expect(rows["dotfiles"]).toBe("node laptop");
  });

  it("replaces a list outright when a layer sets it without .add or .remove", () => {
    const replaced = mergeLayers([
      { source: "a", table: { mcp: { servers: ["x", "y"] } } },
      { source: "b", table: { mcp: { servers: ["z"] } } },
    ]);
    expect(replaced.table).toEqual({ mcp: { servers: ["z"] } });
  });
});

describe("dotfiles", () => {
  const entry = (state: string, target: string | null = null) => ({ src: "zshrc", dest: "~/.zshrc", state, target });
  const diagnose = (state: string, target: string | null = null) =>
    DotfilesArea.diagnose({ node: "laptop", desired: undefined, observed: [entry(state, target)], fleet: [], authority: null });

  it("is quiet when linked", () => {
    expect(diagnose("linked")).toEqual([]);
  });

  it("links a missing file, backing up one that differs first", () => {
    expect(diagnose("missing")[0]?.fix?.command).toBe(
      'mkdir -p "$(dirname "$HOME"/.zshrc)" && ln -sfn "$FLEETX_CHECKOUT/dotfiles/zshrc" "$HOME"/.zshrc',
    );
    expect(diagnose("file-differs")[0]?.fix?.command).toMatch(/^mv "\$HOME"\/\.zshrc "\$HOME"\/\.zshrc\.fleetx-backup\.\$\(date/);
  });

  it("cannot fix a source missing from the repo", () => {
    const [finding] = diagnose("no-source");
    expect(finding?.severity).toBe("error");
    expect(finding?.fix).toBeUndefined();
  });
});
