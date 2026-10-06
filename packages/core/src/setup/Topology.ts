/**
 * Which layout the setup wizard recommends, from what the user says they
 * have. Pure, so the app and the server agree and every rule is tested.
 *
 * The machine setup starts on is always the authority: it approves changes
 * and holds the keys. An always-on machine, when there is one, is the hub:
 * the relay and the MCP hub. A laptop is never recommended as the hub,
 * since it sleeps.
 */

export interface Machines {
  /** Whether the user has a machine that stays on: a home server, a Mac mini, a VPS. */
  readonly alwaysOn: boolean;
  /** How many other machines they run T3 on, besides this one and the always-on one. */
  readonly others: number;
}

export interface Recommendation {
  readonly layout: "single" | "hub" | "several";
  readonly title: string;
  /** One sentence on why. */
  readonly why: string;
  /** What each part does, in the order the wizard shows them. */
  readonly roles: ReadonlyArray<{ readonly machine: string; readonly does: string }>;
}

const THIS = { machine: "This computer", does: "Approves changes and holds the keys" } as const;
const HUB = {
  machine: "Your always-on machine",
  does: "Hub: sends changes the moment they happen, serves the fleet app, can host your MCP servers",
} as const;

export const recommend = ({ alwaysOn, others }: Machines): Recommendation => {
  const rest =
    others > 0
      ? [
          {
            machine: others === 1 ? "Your other machine" : `Your ${others} other machines`,
            does: "Join with what they have, and stay in step",
          },
        ]
      : [];
  if (alwaysOn)
    return {
      layout: "hub",
      title: "This computer and a hub",
      why: "Your always-on machine runs things for the fleet; this computer decides.",
      roles: [THIS, HUB, ...rest],
    };
  if (others > 0)
    return {
      layout: "several",
      title: others === 1 ? "Two machines" : `${others + 1} machines`,
      why: "Every machine syncs from your repository; a hub can be added later.",
      roles: [THIS, ...rest],
    };
  return {
    layout: "single",
    title: "Just this computer",
    why: "Keeps T3 and its providers healthy here, and backs up your setup to a private repository.",
    roles: [THIS],
  };
};
