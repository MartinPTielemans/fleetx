/**
 * What the plan says setup will do beyond this machine's own steps, in plain
 * words: the hub's bring-up, and how the fleet looks after its machines.
 * Pure, so the wizard's fixtures say exactly what the engine says.
 */
import { NTFY_SECRET, UPDATE_WORDS } from "../Upkeep.ts";

/** What bringing the hub up does, for the plan: exactly what Hub.bringUp says as it goes. */
export const hubStepTitles = (hub: { readonly node: string; readonly mcp?: boolean }) => [
  hub.mcp === true
    ? `Add ${hub.node} to the fleet as its relay and MCP hub, with a new relay token among the secrets, and let your Tailscale login open the app it hosts`
    : `Add ${hub.node} to the fleet as its relay, with a new relay token among the secrets, and let your Tailscale login open the app it hosts`,
  `Install T3 Fleet on ${hub.node} and join it to the fleet, over ssh`,
  `Let ${hub.node} read the fleet's secrets`,
  `Approve ${hub.node}'s proposal when it only brings its own secrets`,
  hub.mcp === true
    ? `Sync ${hub.node}, so it starts the relay and hosts your MCP servers`
    : `Sync ${hub.node}, so it starts the relay`,
  `Check that the relay on ${hub.node} answers`,
  ...(hub.mcp === true
    ? [`Once ${hub.node} is up, move your machines' MCP servers to it ([defaults.mcp] hub)`]
    : []),
  `Sync this computer, so it listens to ${hub.node}; your other machines follow on their next sync`,
];

/** The MCP hub, in the plan's words. */
export const mcpHubLine = (node: string) =>
  `Host the fleet's MCP servers on ${node}: sign in to each once, there ([defaults.mcp] hub)`;

/** What a run sets for looking after the machines, a line each, for its plan. */
export const settingsWords = (set: {
  readonly node: string;
  /** This machine, the relay, hosts the MCP servers (the terminal's --relay --mcp-hub). */
  readonly mcpHub: boolean;
  /** [fleet] apply with updates on or off; null leaves it. */
  readonly autoUpdate: boolean | null;
  /** This machine in [notify] desktop, out of it, or left (null). */
  readonly desktop: boolean | null;
  readonly ntfy: boolean;
  /** The MCP hub turned off ([defaults.mcp] hub = false). */
  readonly mcpHubOff?: boolean;
}): ReadonlyArray<string> => [
  ...(set.mcpHub ? [mcpHubLine(set.node)] : []),
  ...(set.mcpHubOff === true
    ? ["Run your MCP servers on each machine again, not on the hub ([defaults.mcp] hub = false)"]
    : []),
  ...(set.autoUpdate === true
    ? [`Keep things up to date automatically: ${UPDATE_WORDS.join(" · ")} ([fleet] apply)`]
    : set.autoUpdate === false
      ? [
          "Leave updates for you to apply; sync still keeps MCP servers, instructions and secrets in place ([fleet] apply)",
        ]
      : []),
  ...(set.desktop === true
    ? [`Notify you on ${set.node} for every fleet alert ([notify] desktop)`]
    : set.desktop === false
      ? [`No notifications on ${set.node} (out of [notify] desktop, if it was there)`]
      : []),
  ...(set.ntfy
    ? [
        `Push every fleet alert to your phone with ntfy ([notify] ntfy; the topic URL is the secret ${NTFY_SECRET})`,
      ]
    : []),
];
