/**
 * Talking to `t3-fleet ui`. Every answer is decoded with the same Api.ts schema
 * the server encoded it with, so a shape the two disagree on fails here,
 * loudly, instead of rendering half a page.
 *
 * `t3-fleet ui` opens the app with a one-use ticket in the URL fragment; the
 * app trades it for a token and keeps that in sessionStorage, so a reload
 * keeps working but nothing outlives the tab. A tab opened from this one asks
 * the tabs already open for the token. If the ticket was already used, the
 * page says so: someone else opened the link.
 */
import {
  HubCall,
  HubLoginStart,
  HubServer,
  UiAlert,
  UiCheckFailed,
  UiConfigRow,
  UiFixPlan,
  UiJob,
  UiModels,
  UiProposal,
  UiSession,
  UiSessionGrant,
  UiSkills,
  UiSkillsLookup,
  UiSkillsPreview,
  UiStatus,
} from "@t3-fleet/core/Api";
import {
  UiInvite,
  UiProbe,
  UiSetupPlan,
  UiSetupStarted,
  UiSetupState,
  type UiSetupApplyRequest,
  type UiSetupPlanRequest,
} from "@t3-fleet/core/SetupApi";
import * as Schema from "effect/Schema";

const TOKEN_KEY = "t3-fleet:token";
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("t3-fleet");

const token = () => window.sessionStorage.getItem(TOKEN_KEY) ?? "";

// Tabs share the token with tabs of this origin that ask for it.
channel?.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.data === "token?" && token() !== "") channel.postMessage({ token: token() });
});

/** A token from another open tab, or "" when none answers. */
const askOtherTabs = () =>
  new Promise<string>((resolve) => {
    if (channel === null) return resolve("");
    const answer = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (
        typeof data === "object" &&
        data !== null &&
        "token" in data &&
        typeof data.token === "string"
      ) {
        channel.removeEventListener("message", answer);
        resolve(data.token);
      }
    };
    channel.addEventListener("message", answer);
    channel.postMessage("token?");
    window.setTimeout(() => {
      channel.removeEventListener("message", answer);
      resolve("");
    }, 400);
  });

/** Why this tab has no token, or null when it has one. */
export type SessionStart =
  | { readonly ok: true }
  | { readonly ok: false; readonly title: string; readonly message: string };

/** Trade the link's ticket for a token, or find the one this tab (or another) already has. */
export async function startSession(): Promise<SessionStart> {
  const ticket = /(?:^#|&)ticket=([0-9a-f]+)/.exec(window.location.hash)?.[1];
  if (ticket !== undefined) {
    // Gone from the address bar (and history) before anything else can read it.
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
    let response: Response;
    try {
      response = await fetch("/api/session", {
        method: "POST",
        headers: { "x-t3-fleet-ticket": ticket },
      });
    } catch {
      return { ok: false, title: "t3-fleet ui is not answering", message: "Is it still running?" };
    }
    const text = await response.text();
    if (response.status === 410)
      return { ok: false, title: "This link was already used", message: text.trim() };
    if (!response.ok)
      return {
        ok: false,
        title: "This link is not from this run of t3-fleet ui",
        message: text.trim(),
      };
    window.sessionStorage.setItem(TOKEN_KEY, decoder(UiSessionGrant)("/api/session", text).token);
    return { ok: true };
  }
  if (token() !== "") return { ok: true };
  const shared = await askOtherTabs();
  if (shared !== "") {
    window.sessionStorage.setItem(TOKEN_KEY, shared);
    return { ok: true };
  }
  return {
    ok: false,
    title: "Open the link t3-fleet ui printed",
    message: "Each link works once; t3-fleet ui prints a new one for another tab.",
  };
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The hub or the models part is not there (yet): no relay, no hub on it, or no answer. */
export const isUnavailable = (error: unknown) =>
  error instanceof ApiError && [404, 502, 503].includes(error.status);
export const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401;

async function request(method: "GET" | "POST", path: string, body?: unknown): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        "x-t3-fleet-token": token(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError(0, "t3-fleet ui is not answering; is it still running?");
  }
  const text = await response.text();
  if (!response.ok)
    throw new ApiError(response.status, text.trim() || `${response.status} ${response.statusText}`);
  return text;
}

function decoder<S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) {
  const decode = Schema.decodeSync(Schema.fromJsonString(schema));
  return (path: string, text: string): S["Type"] => {
    try {
      return decode(text);
    } catch (error) {
      throw new ApiError(
        -1,
        `${path} answered in a shape this page does not understand: ${String(error).split("\n")[0]}`,
      );
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
const getSkills = get(UiSkills);
const getJobs = get(Schema.Array(UiJob));
const decodeLogin = decoder(HubLoginStart);
const getSetupState = get(UiSetupState);

const post = <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) => {
  const decode = decoder(schema);
  return async (path: string, body: unknown): Promise<S["Type"]> =>
    decode(path, await request("POST", path, body));
};
const postPlan = post(UiFixPlan);
const postLookup = post(UiSkillsLookup);
const postPreview = post(UiSkillsPreview);
/** Starts a job; the answer is the job as it begins. */
const postJob = post(UiJob);
const postProbe = post(UiProbe);
const postSetupPlan = post(UiSetupPlan);
const postSetupApply = post(UiSetupStarted);
const postInvite = post(UiInvite);

export const decodeStatusEvent = decoder(UiStatus);
export const decodeCheckFailedEvent = decoder(UiCheckFailed);
export const decodeJobEvent = decoder(UiJob);
export const decodeSessionEvent = decoder(UiSession);

export const api = {
  session: () => getSession("/api/session"),
  status: (fresh = false) => getStatus(fresh ? "/api/status?fresh=1" : "/api/status"),
  /** The fixes as they would run now, each with the digest that applying them sends back. */
  planFixes: (ids: ReadonlyArray<string>) => postPlan("/api/fixes/plan", { ids }),
  applyFixes: (
    fixes: ReadonlyArray<{ readonly id: string; readonly digest: string }>,
    acknowledged: ReadonlyArray<string>,
  ) => postJob("/api/fixes", { fixes, acknowledged }),
  jobs: () => getJobs("/api/jobs"),
  proposals: () => getProposals("/api/proposals"),
  approve: (node: string, commit: string) =>
    postJob(`/api/proposals/${encodeURIComponent(node)}/approve`, { commit }),
  reject: (node: string, commit: string) =>
    postJob(`/api/proposals/${encodeURIComponent(node)}/reject`, { commit }),
  alerts: () => getAlerts("/api/alerts"),
  models: () => getModels("/api/models"),
  hubServers: () => getHubServers("/api/hub/servers"),
  hubCalls: (server: string | null, limit = 200) =>
    getHubCalls(
      `/api/hub/calls?limit=${limit}${server === null ? "" : `&server=${encodeURIComponent(server)}`}`,
    ),
  hubLogin: async (name: string) => {
    const path = `/api/hub/servers/${encodeURIComponent(name)}/login`;
    return decodeLogin(path, await request("POST", path));
  },
  hubLogout: (name: string) =>
    request("POST", `/api/hub/servers/${encodeURIComponent(name)}/logout`).then(() => undefined),
  hubRestart: (name: string) =>
    request("POST", `/api/hub/servers/${encodeURIComponent(name)}/restart`).then(() => undefined),
  config: (node: string) => getConfig(`/api/config/${encodeURIComponent(node)}`),
  skills: () => getSkills("/api/skills"),
  skillsLookup: (source: string) => postLookup("/api/skills/lookup", { source }),
  skillsAdd: (source: string, skills: ReadonlyArray<string>, as?: string) =>
    postJob("/api/skills/add", { source, skills, ...(as === undefined ? {} : { as }) }),
  /** Every skill with a source when `skills` is empty. */
  skillsPreview: (skills: ReadonlyArray<string>) => postPreview("/api/skills/preview", { skills }),
  skillsUpdate: (skills: ReadonlyArray<string>, digest: string) =>
    postJob("/api/skills/update", { skills, digest }),
  skillsRemove: (skills: ReadonlyArray<string>) => postJob("/api/skills/remove", { skills }),
  /** Where this machine stands: in a fleet, not yet, or part-way through setup. */
  setupState: () => getSetupState("/api/setup/state"),
  setupProbe: (ssh: string) => postProbe("/api/setup/probe", { ssh }),
  setupPlan: (request: UiSetupPlanRequest) => postSetupPlan("/api/setup/plan", request),
  setupApply: (request: UiSetupApplyRequest) => postSetupApply("/api/setup/apply", request),
  setupInvite: (node: string) => postInvite("/api/setup/invite", { node }),
  /** EventSource cannot send headers; the token goes in the query instead, which only this endpoint accepts. */
  eventsUrl: () => `/api/events?token=${encodeURIComponent(token())}`,
};

export type {
  HubCall as HubCallT,
  HubServer as HubServerT,
  UiApplyResult as UiApplyResultT,
  UiFixPlan as UiFixPlanT,
  UiJob as UiJobT,
  UiModels as UiModelsT,
  UiPlannedFix as UiPlannedFixT,
  UiProposal as UiProposalT,
  UiSession,
  UiSkills as UiSkillsT,
  UiSkillsLanded as UiSkillsLandedT,
  UiSkillsLookup as UiSkillsLookupT,
  UiSkillsPreview as UiSkillsPreviewT,
  UiStatus,
} from "@t3-fleet/core/Api";
export type {
  UiInvite,
  UiPlanConflict,
  UiPlanItem,
  UiProbe,
  UiProbeItem,
  UiSetupCheck,
  UiSetupPlan,
  UiSetupState,
} from "@t3-fleet/core/SetupApi";
export type UiAlertT = typeof UiAlert.Type;
