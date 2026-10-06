import { describe, expect, it } from "vite-plus/test";

import { recommend } from "./Topology.ts";

describe("recommend", () => {
  it("is a single machine with nothing else", () => {
    expect(recommend({ alwaysOn: false, others: 0 }).layout).toBe("single");
  });

  it("makes an always-on machine the hub, and this computer the authority", () => {
    const r = recommend({ alwaysOn: true, others: 2 });
    expect(r.layout).toBe("hub");
    expect(r.roles.map((x) => x.machine)).toEqual([
      "This computer",
      "Your always-on machine",
      "Your 2 other machines",
    ]);
  });

  it("never makes another machine the hub without an always-on one", () => {
    const r = recommend({ alwaysOn: false, others: 1 });
    expect(r.layout).toBe("several");
    expect(r.roles.some((x) => x.does.startsWith("Hub"))).toBe(false);
  });
});
