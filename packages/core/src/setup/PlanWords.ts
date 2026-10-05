/**
 * What the plan says setup will do beyond this machine's own steps, in plain
 * words: the hub's bring-up, and how the fleet looks after its machines.
 * Pure, so the wizard's fixtures say exactly what the engine says.
 */
import { NTFY_SECRET, UPDATE_WORDS } from "../Upkeep.ts";

/** What bringing the hub up does, for the plan: exactly what Hub.bringUp says as it goes. */
export const hubStepTitles = (hub: { readonly node: string; readonly mcp?: boolean }) => [
  hub.mcp === true
    ? `Add ${hub.node} to the fleet as its relay and MCP hub, with a new relay token among the secrets`
    : `Add ${hub.node} to the fleet as its relay, with a new relay token among the secrets`,
  `Install T3 Fleet on ${hub.node} and join it to the fleet, over ssh`,
  `Let ${hub.node} read the fleet's secrets`,
  `Approve ${hub.node}'s proposal when it only touches its own files`,
  hub.mcp === true
    ? `Sync ${hub.node}, so it starts the relay and hosts your MCP servers`
    : `Sync ${hub.node}, so it starts the relay`,
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
  readonly desktop: boolean;
  readonly ntfy: boolean;
}): ReadonlyArray<string> => [
  ...(set.mcpHub ? [mcpHubLine(set.node)] : []),
  ...(set.autoUpdate === true
    ? [`Keep things up to date automatically: ${UPDATE_WORDS.join(" · ")} ([fleet] apply)`]
    : set.autoUpdate === false
      ? [
          "Leave updates for you to apply; sync still keeps MCP servers, instructions and secrets in place ([fleet] apply)",
        ]
      : []),
  ...(set.desktop ? [`Notify you on ${set.node} for every fleet alert ([notify] desktop)`] : []),
  ...(set.ntfy
    ? [
        `Push every fleet alert to your phone with ntfy ([notify] ntfy; the topic URL is the secret ${NTFY_SECRET})`,
      ]
    : []),
];
