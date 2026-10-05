/**
 * Which of the fleet's MCP servers the hub takes over when it hosts them
 * ([defaults.mcp] hub). Pure, so the plan lists exactly what the switch
 * moves before anything is written, and the step that moves them says the
 * same.
 *
 * The hub hosts the kinds in docs/areas.md "The hub": a `remote` server it
 * proxies to its https URL, adding the server's credential (a bearer secret
 * or an OAuth login made once, there), and the `container`, `registry` and
 * `hosted-stdio` kinds declared for it. What setup imports is `direct` (a URL
 * each machine connects to) or `stdio` (a command each machine runs):
 *
 *   direct, https, nothing else    moves: `remote`, every field the hub reads for
 *                                  one kept (its bearer secret, remote_auth and
 *                                  its scopes, a static oauth client, tools.deny)
 *                                  and anything else it holds; only what a
 *                                  machine alone reads (transport) goes
 *   direct the hub could not serve stays: an oauth client without its https
 *                                  issuer, say; the hub's own reason given
 *   direct with its own headers    stays: the hub sends only the credential
 *   direct over SSE                stays: the hub proxies streamable HTTP
 *   direct with a secret in its URL  stays: the hub does not fill one in
 *   direct over plain http         stays: the hub reaches only https servers
 *   stdio                          stays: a command runs on the machine that
 *                                  has it; the hub runs only what is declared
 *                                  for it (a container, a hosted-stdio command)
 *   remote, container, …           on the hub already
 */
import { HOSTED_KINDS, isProblem, parseDefinition } from "../hub/Definitions.ts";

export type Hosting =
  | { readonly on: "hub"; readonly definition: Readonly<Record<string, unknown>> | null }
  | { readonly on: "machines"; readonly why: string };

/**
 * Where `definition` runs once the hub hosts the fleet's servers: on the hub
 * (with the definition to write, or null when it is hosted already), or on
 * each machine, with why.
 */
export const hostingOf = (definition: Readonly<Record<string, unknown>>): Hosting => {
  const kind = definition["kind"];
  if (typeof kind === "string" && HOSTED_KINDS.includes(kind))
    return { on: "hub", definition: null };
  if (kind === "stdio")
    return {
      on: "machines",
      why: "it runs a command on each machine, and the hub runs only containers and commands declared for it",
    };
  if (kind !== "direct")
    return { on: "machines", why: `its kind (${String(kind)}) is not one the hub hosts` };
  const url = definition["url"];
  if (typeof url !== "string" || url === "")
    return { on: "machines", why: "it has no URL for the hub to reach" };
  if (/\$\{?[A-Za-z_]/.test(url))
    return { on: "machines", why: "its URL carries a secret, which the hub does not fill in" };
  if (!/^https:\/\//i.test(url))
    return {
      on: "machines",
      why: "its address is plain http, and the hub reaches only https servers",
    };
  if (definition["transport"] === "sse")
    return { on: "machines", why: "it speaks SSE, which the hub does not proxy" };
  const headers = definition["headers"];
  if (typeof headers === "object" && headers !== null && Object.keys(headers).length > 0)
    return {
      on: "machines",
      why: "it sends headers of its own, and the hub sends only the server's credential",
    };
  // Everything but what only a machine reads: the hub reads the rest of a remote's fields too.
  const { kind: _kind, transport: _transport, headers: _headers, ...rest } = definition;
  const remote = { kind: "remote", ...rest, url };
  const served = parseDefinition("server", JSON.stringify(remote));
  if (isProblem(served))
    return { on: "machines", why: `the hub could not serve it: ${served.problem}` };
  return { on: "hub", definition: remote };
};

/** Each server by name, sorted: on the hub (moved now, or there already) or on each machine, with why. */
export const hostingPlan = (
  definitions: ReadonlyMap<string, Readonly<Record<string, unknown>>>,
): ReadonlyArray<{ readonly name: string; readonly hub: boolean; readonly why: string | null }> =>
  [...definitions.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, d]) => {
      const h = hostingOf(d);
      return h.on === "hub" ? { name, hub: true, why: null } : { name, hub: false, why: h.why };
    });

/** The plan's words for it: which servers the hub takes over, and which stay where they are, and why. */
export const hostingWords = (
  node: string,
  plan: ReadonlyArray<{
    readonly name: string;
    readonly hub: boolean;
    readonly why: string | null;
  }>,
): ReadonlyArray<string> => {
  const moving = plan.filter((s) => s.hub).map((s) => s.name);
  const staying = plan.filter((s) => !s.hub);
  return [
    moving.length === 0
      ? `No MCP server moves to ${node}: none is one it can host`
      : `On ${node}: ${moving.join(", ")}`,
    ...staying.map((s) => `Stays on each machine: ${s.name}, as ${s.why ?? "it is"}`),
  ];
};
