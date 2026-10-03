/**
 * Talking to `fleetx ui`. Every answer is decoded with the same Api.ts schema
 * the server encoded it with, so a shape the two disagree on fails here,
 * loudly, instead of rendering half a page.
 *
 * The server wants this run's token on every request. `fleetx ui` opens the
 * app with it in the URL fragment; it is kept in localStorage (readable only
 * by this origin) so reloads and new tabs keep working until the next run.
 */
import {
  HubCall,
  HubLoginStart,
  HubServer,
  UiAlert,
  UiApplyResult,
  UiConfigRow,
  UiModels,
  UiProposal,
  UiSession,
  UiStatus,
} from "@fleetx/core/Api";
import * as Schema from "effect/Schema";

const TOKEN_KEY = "fleetx:token";

/** Take the token from the fragment `fleetx ui` opened, and drop it from the address bar. */
export function adoptToken(): void {
  const match = /(?:^#|&)token=([0-9a-f]+)/.exec(window.location.hash);
  if (match?.[1] === undefined) return;
  window.localStorage.setItem(TOKEN_KEY, match[1]);
  window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
}

const token = () => window.localStorage.getItem(TOKEN_KEY) ?? "";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The hub or the models part is not there (yet): no relay, no hub on it, or no answer. */
export const isUnavailable = (error: unknown) => error instanceof ApiError && [404, 502, 503].includes(error.status);
export const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: { "x-fleetx-token": token(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "fleetx ui is not answering; is it still running?");
  }
  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, text.trim() || `${response.status} ${response.statusText}`);
  return text;
}

function decoder<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) {
  const decode = Schema.decodeSync(Schema.fromJsonString(schema));
  return (path: string, text: string): S["Type"] => {
    try {
      return decode(text);
    } catch (error) {
      throw new ApiError(-1, `${path} answered in a shape this page does not understand: ${String(error).split("\n")[0]}`);
    }
  };
}

const get = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
  const decode = decoder(schema);
  return async (path: string): Promise<S["Type"]> => decode(path, await request("GET", path));
};

const getSession = get(UiSession);
const getStatus = get(UiStatus);
const getProposals = get(Schema.Array(UiProposal));
const getAlerts = get(Schema.Array(UiAlert));
const getModels = get(UiModels);
const getHubServers = get(Schema.Array(HubServer));
const getHubCalls = get(Schema.Array(HubCall));
const getConfig = get(Schema.Array(UiConfigRow));
const decodeApply = decoder(UiApplyResult);
const decodeLogin = decoder(HubLoginStart);

export const decodeStatusEvent = decoder(UiStatus);

export const api = {
  session: () => getSession("/api/session"),
  status: (fresh = false) => getStatus(fresh ? "/api/status?fresh=1" : "/api/status"),
  applyFixes: async (ids: ReadonlyArray<string>) => decodeApply("/api/fixes", await request("POST", "/api/fixes", { ids })),
  proposals: () => getProposals("/api/proposals"),
  approve: (node: string) => request("POST", `/api/proposals/${encodeURIComponent(node)}/approve`).then(() => undefined),
  reject: (node: string) => request("POST", `/api/proposals/${encodeURIComponent(node)}/reject`).then(() => undefined),
  alerts: () => getAlerts("/api/alerts"),
  models: () => getModels("/api/models"),
  hubServers: () => getHubServers("/api/hub/servers"),
  hubCalls: (server: string | null, limit = 200) =>
    getHubCalls(`/api/hub/calls?limit=${limit}${server === null ? "" : `&server=${encodeURIComponent(server)}`}`),
  hubLogin: async (name: string) => {
    const path = `/api/hub/servers/${encodeURIComponent(name)}/login`;
    return decodeLogin(path, await request("POST", path));
  },
  hubLogout: (name: string) => request("POST", `/api/hub/servers/${encodeURIComponent(name)}/logout`).then(() => undefined),
  hubRestart: (name: string) => request("POST", `/api/hub/servers/${encodeURIComponent(name)}/restart`).then(() => undefined),
  config: (node: string) => getConfig(`/api/config/${encodeURIComponent(node)}`),
  /** EventSource cannot send headers; the token goes in the query instead. */
  eventsUrl: () => `/api/events?token=${encodeURIComponent(token())}`,
};

export type {
  HubCall as HubCallT,
  HubServer as HubServerT,
  UiApplyResult as UiApplyResultT,
  UiModels as UiModelsT,
  UiProposal as UiProposalT,
  UiSession,
  UiStatus,
} from "@fleetx/core/Api";
export type UiAlertT = typeof UiAlert.Type;
