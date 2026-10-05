import { describe, expect, it } from "vite-plus/test";

import { busyThreads, desktopBundle, macZip, withContinuation } from "./T3Update.ts";

describe("T3 updates", () => {
  it("counts a thread as busy while it has an active run or run activity", () => {
    expect(
      busyThreads({
        threads: [
          { title: "idle", activeRunId: null, activityRunStatus: null },
          { title: "settled" },
          { title: "working", activeRunId: "run:1", activityRunStatus: "running" },
          { title: "asking", activeRunId: null, activityRunStatus: "waiting" },
        ],
      }),
    ).toEqual(["working", "asking"]);
  });

  it("turns continuing threads on, keeping every other setting, and leaves it alone once on", () => {
    const edited = withContinuation('{"providers":{"codex":{"enabled":true}}}');
    expect(JSON.parse(edited ?? "")).toEqual({
      providers: { codex: { enabled: true } },
      continueThreadsAfterServerUpdate: true,
    });
    expect(withContinuation(edited ?? "")).toBeNull();
    expect(withContinuation("not json")).toBeNull();
  });

  it("tells the desktop app's bundled server from a CLI install", () => {
    expect(
      desktopBundle(
        "/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly) --require /Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/x.cjs /Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs",
      ),
    ).toBe("/Applications/T3 Code (Nightly).app");
    expect(
      desktopBundle("/home/u/.t3/runtime/versions/0.0.46-nightly.20261003.2632/t3 serve"),
    ).toBeNull();
  });

  it("picks the app zip for this architecture from a release's mac manifest", () => {
    const yml = [
      "version: '0.0.46-nightly.20261005.2667'",
      "files:",
      "  - url: T3-Code-0.0.46-nightly.20261005.2667-arm64.zip",
      "    sha512: ARM==",
      "    size: 1",
      "  - url: T3-Code-0.0.46-nightly.20261005.2667-arm64.dmg",
      "    sha512: DMG==",
      "  - url: T3-Code-0.0.46-nightly.20261005.2667-x64.zip",
      "    sha512: X64==",
    ].join("\n");
    expect(macZip(yml, "arm64")).toEqual({
      file: "T3-Code-0.0.46-nightly.20261005.2667-arm64.zip",
      sha512: "ARM==",
    });
    expect(macZip(yml, "x64")?.sha512).toBe("X64==");
    expect(macZip("files: []", "arm64")).toBeNull();
  });
});
