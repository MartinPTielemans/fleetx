import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The page's globals, as a tab on the hub has them: no other tab, and a token from before.
const storage = new Map<string, string>();
const calls: Array<{ path: string; token: string | null; hub: string | null }> = [];
let issued = 0;
let valid = "";
let isHub = true;

const answer = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  storage.clear();
  calls.length = 0;
  issued = 0;
  valid = "fresh-0";
  isHub = true;
  vi.stubGlobal("BroadcastChannel", undefined);
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    },
    location: { hash: "", pathname: "/", search: "" },
    history: { state: null, replaceState: () => undefined },
    setTimeout,
  });
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      path,
      token: headers["x-t3-fleet-token"] ?? null,
      hub: headers["x-t3-fleet-hub"] ?? null,
    });
    if (path === "/api/session" && init.method === "POST") {
      if (!isHub) return answer(401, "Open the link t3-fleet ui printed");
      valid = `fresh-${issued++}`;
      return answer(200, JSON.stringify({ token: valid }));
    }
    return headers["x-t3-fleet-token"] === valid
      ? answer(200, JSON.stringify({ command: "invited" }))
      : answer(401, "unknown token");
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

const load = () => import("./api");

describe("a hub token after the relay restarted (PR #47)", () => {
  it("asks the hub for a new token once, and makes the call again with it", async () => {
    storage.set("t3-fleet:token", "from-before-the-restart");
    const { api } = await load();
    expect(await api.setupInvite("desk")).toEqual({ command: "invited" });
    expect(calls.map((c) => [c.path, c.token ?? c.hub])).toEqual([
      ["/api/setup/invite", "from-before-the-restart"],
      ["/api/session", "1"],
      ["/api/setup/invite", "fresh-0"],
    ]);
    expect(storage.get("t3-fleet:token")).toBe("fresh-0");
  });

  it("calls answered 401 together share one new token", async () => {
    storage.set("t3-fleet:token", "from-before-the-restart");
    const { api } = await load();
    await Promise.all([api.setupInvite("a"), api.setupInvite("b"), api.setupInvite("c")]);
    expect(calls.filter((c) => c.path === "/api/session")).toHaveLength(1);
  });

  it("on t3-fleet ui (a ticket, not the hub) a 401 stays one: no retry, no loop", async () => {
    isHub = false;
    storage.set("t3-fleet:token", "from-an-earlier-run");
    const { api, isUnauthorized } = await load();
    const error = await api.setupInvite("desk").catch((e: unknown) => e);
    expect(isUnauthorized(error)).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(["/api/setup/invite", "/api/session"]);
  });
});
