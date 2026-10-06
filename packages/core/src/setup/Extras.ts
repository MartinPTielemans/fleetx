/**
 * Which optional extras setup offers. Only one not set up yet; on a machine
 * set up already, only what the user asked for with a flag, or every one
 * when none is set up at all: an unrelated change (a server left alone, say)
 * is no reason to ask about a model proxy.
 */
import type { Mode } from "./Plan.ts";

export type ExtraName = "relay" | "model proxy" | "T3 access";

const WHY: Readonly<Record<ExtraName, string>> = {
  relay: "an always-on machine: instant sync, alerts for every machine, the fleet's app",
  "model proxy": "retries, stats, a login that doesn't expire",
  "T3 access": "provider logins and health as T3 itself sees them",
};

export const extraOffers = (input: {
  readonly mode: Mode;
  /** What is set up already: a [relay] in the fleet, [models] settings, T3 Fleet's T3 token here. */
  readonly configured: Readonly<Record<ExtraName, boolean>>;
  /** Asked for on the command line (--relay, --models). */
  readonly asked: Readonly<Partial<Record<ExtraName, boolean>>>;
  /** T3 access needs a T3 server running here. */
  readonly t3Running: boolean;
}): ReadonlyArray<readonly [ExtraName, string]> => {
  const names = (["relay", "model proxy", "T3 access"] as const).filter(
    (n) => !input.configured[n] && (n !== "T3 access" || input.t3Running),
  );
  const noneSetUp = !Object.values(input.configured).some(Boolean);
  const offered =
    input.mode === "again" && !noneSetUp ? names.filter((n) => input.asked[n] === true) : names;
  return offered.map((n) => [n, WHY[n]] as const);
};
