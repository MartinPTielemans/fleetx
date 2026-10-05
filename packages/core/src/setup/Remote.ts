/**
 * The hub, reached over ssh from the machine setup runs on.
 *
 * STUB: the wizard's remote stream replaces this file with the real probe and
 * bring-up. Only the signatures are relied on (Wizard.ts, Hub.ts); until then
 * the probe says it cannot tell, and bringing a hub up fails with why.
 */
import * as Effect from "effect/Effect";

import type { UiProbe } from "../SetupApi.ts";

const unknown = { state: "unknown", label: "not checked", remedy: null } as const;

/** What the hub has, as found over ssh. Read-only; never fails: errors go in the result. */
export const probeHub = (ssh: string): Effect.Effect<UiProbe> =>
  Effect.succeed({
    ssh,
    reachable: false,
    error: "this build cannot check a hub over ssh yet",
    hostname: null,
    os: null,
    node: unknown,
    git: unknown,
    t3: unknown,
    tailscale: unknown,
    docker: unknown,
    service: unknown,
    relayUrl: null,
    ready: false,
  });

/** Install T3 Fleet on the hub and join it to the fleet as `node`, the relay; each step said through `onStep`. */
export const bringUpHub = (_input: {
  readonly ssh: string;
  readonly node: string;
  readonly repoUrl: string;
  readonly relayUrl: string | null;
  readonly onStep: (step: string) => Effect.Effect<void>;
}): Effect.Effect<void, string> => Effect.fail("this build cannot bring a hub up over ssh yet");
