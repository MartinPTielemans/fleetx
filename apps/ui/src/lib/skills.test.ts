import { describe, expect, it } from "vite-plus/test";

import { skippedNote } from "./skills";

describe("an update preview", () => {
  it("says which held skills it skipped, as the CLI does", () => {
    expect(skippedNote([])).toBeNull();
    expect(skippedNote(["skills/a", "skills/c"])).toContain(
      "Skipped skills/a, skills/c: sync holds back an edit there",
    );
  });
});
