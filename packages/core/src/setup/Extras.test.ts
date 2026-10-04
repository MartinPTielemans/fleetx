import { describe, expect, it } from "vite-plus/test";

import { extraOffers } from "./Extras.ts";

const none = { relay: false, "model proxy": false, "T3 access": false };
const names = (offers: ReadonlyArray<readonly [string, string]>) => offers.map(([n]) => n);

describe("extraOffers", () => {
  it("offers, on a first or joining machine, every extra not set up yet", () => {
    expect(
      names(extraOffers({ mode: "first", configured: none, asked: {}, t3Running: true })),
    ).toEqual(["relay", "model proxy", "T3 access"]);
    expect(
      names(
        extraOffers({
          mode: "join",
          configured: { ...none, relay: true },
          asked: {},
          t3Running: false,
        }),
      ),
    ).toEqual(["model proxy"]);
  });

  it("on a machine set up already, offers only what was asked for once anything is set up", () => {
    const relayed = { ...none, relay: true };
    // A server left alone is no reason to ask about a model proxy.
    expect(extraOffers({ mode: "again", configured: relayed, asked: {}, t3Running: true })).toEqual(
      [],
    );
    expect(
      names(
        extraOffers({
          mode: "again",
          configured: relayed,
          asked: { "model proxy": true },
          t3Running: true,
        }),
      ),
    ).toEqual(["model proxy"]);
    // Asked for, but set up already: nothing to offer.
    expect(
      extraOffers({ mode: "again", configured: relayed, asked: { relay: true }, t3Running: false }),
    ).toEqual([]);
    // Nothing set up at all: every extra is still on offer.
    expect(
      names(extraOffers({ mode: "again", configured: none, asked: {}, t3Running: false })),
    ).toEqual(["relay", "model proxy"]);
  });
});
