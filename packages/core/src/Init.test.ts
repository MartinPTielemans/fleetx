// The invite line is pasted into a shell on the new machine: every URL and
// name must arrive as exactly one argument, and nothing in them may run.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

import { inviteLine } from "./Init.ts";

/** What `sh` hands setup as its arguments when it runs the line's tail. */
const argsSetupGets = (line: string) => {
  const tail = line.slice(line.indexOf("| sh -s -- ") + "| sh -s -- ".length);
  const out = execFileSync("sh", ["-c", `set -- ${tail}; printf '%s\\0' "$@"`], {
    encoding: "utf8",
  });
  return out.split("\0").slice(0, -1);
};

describe("inviteLine", () => {
  it("leaves an ordinary URL and name readable", () => {
    expect(inviteLine("git@github.com:o/fleet.git", "desk")).toMatch(
      / \| sh -s -- setup git@github\.com:o\/fleet\.git desk$/,
    );
  });

  it.each([
    ["https://git.example/fleet.git?a=1&b=2", "desk"],
    ["https://x/f.git; touch /tmp/pwned-by-invite", "desk"],
    ["https://x/$(touch /tmp/pwned-by-invite).git", "`id`"],
    ["/srv/my fleet/repo.git", "my desk"],
    ["https://x/it's.git", 'say "hi"'],
    ["", "$HOME"],
  ])("passes %j and %j through as two plain arguments", (url, name) => {
    expect(argsSetupGets(inviteLine(url, name))).toEqual(["setup", url, name]);
  });
});
