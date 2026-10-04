/**
 * Services: Docker Compose stacks a node runs, reported only. Services deploy
 * from their own repositories; T3 Fleet never starts, stops or recreates one.
 * It reports whether each declared stack is running, and whether the compose
 * file it runs from still matches the repo's copy (services/<name>/), and can
 * capture the running file into the repo.
 *
 *   services = ["web", "db"]     # stacks this node runs
 *
 * The compose project name is the service name.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { defineArea, sh } from "../Area.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";

const Observed = Schema.Struct({
  docker: Schema.Boolean,
  services: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      /** Running containers / all containers of the project. */
      running: Schema.Number,
      total: Schema.Number,
      /** The compose file the running project was started from, if known. */
      composeFile: Schema.NullOr(Schema.String),
      /** Running compose file equals the repo's services/<name>/docker-compose.yml. */
      matchesRepo: Schema.NullOr(Schema.Boolean),
      inRepo: Schema.Boolean,
    }),
  ),
});

export const ServicesArea = defineArea({
  id: "services",
  description: "Docker Compose stacks each node runs (reported, never deployed)",
  desired: Schema.UndefinedOr(Schema.Array(Schema.String)),
  observed: Observed,
  observe: (desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const names = desired ?? [];
      if (names.length === 0) return { docker: false, services: [] };
      const docker =
        (yield* exec({
          command: "docker",
          args: ["version", "--format", "{{.Server.Version}}"],
          env: ctx.env,
          timeout: Duration.seconds(10),
        })).code === 0;
      if (!docker)
        return {
          docker,
          services: names.map((name) => ({
            name,
            running: 0,
            total: 0,
            composeFile: null,
            matchesRepo: null,
            inRepo: false,
          })),
        };
      const services = yield* Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          const ps = yield* exec({
            command: "docker",
            args: [
              "ps",
              "-a",
              "--filter",
              `label=com.docker.compose.project=${name}`,
              "--format",
              '{{.State}}\t{{.Label "com.docker.compose.project.config_files"}}',
            ],
            env: ctx.env,
            timeout: Duration.seconds(15),
          });
          const rows = ps.stdout
            .split("\n")
            .filter(Boolean)
            .map((l) => l.split("\t"));
          const composeFile = rows.find((r) => r[1])?.[1]?.split(",")[0] ?? null;
          const repoFile = `${ctx.checkout}/services/${name}/docker-compose.yml`;
          const repoText = yield* fs.readFileString(repoFile).pipe(Effect.option);
          const liveText =
            composeFile === null
              ? Option.none<string>()
              : yield* fs.readFileString(composeFile).pipe(Effect.option);
          return {
            name,
            running: rows.filter((r) => r[0] === "running").length,
            total: rows.length,
            composeFile,
            matchesRepo:
              Option.isSome(repoText) && Option.isSome(liveText)
                ? repoText.value === liveText.value
                : null,
            inRepo: Option.isSome(repoText),
          };
        }),
      );
      return { docker, services };
    }),
  diagnose: ({ node, observed, desired }) => {
    const out: Array<Finding> = [];
    if ((desired ?? []).length === 0) return out;
    const base = { node, area: "services" as const };
    if (!observed.docker) {
      out.push({
        ...base,
        key: "services-no-docker",
        severity: "error",
        title: "this machine runs services, but Docker is not answering",
      });
      return out;
    }
    for (const s of observed.services) {
      if (s.total === 0)
        out.push({
          ...base,
          key: `service-${s.name}-absent`,
          severity: "error",
          title: `service ${s.name} has no containers here`,
        });
      else if (s.running < s.total) {
        out.push({
          ...base,
          key: `service-${s.name}-down`,
          severity: "error",
          title: `service ${s.name}: ${s.running} of ${s.total} containers running`,
        });
      }
      if (s.composeFile !== null && (s.matchesRepo === false || !s.inRepo)) {
        out.push({
          ...base,
          key: `service-${s.name}-drift`,
          severity: "info",
          title: `service ${s.name} runs from a compose file ${s.inRepo ? "that differs from" : "missing in"} the repo's services/${s.name}/`,
          detail: `running from ${s.composeFile}; services deploy from their own repos, so the repo copy is captured, not applied`,
          fix: {
            command: `mkdir -p "$T3_FLEET_CHECKOUT/services/${s.name}" && cp ${sh(s.composeFile)} "$T3_FLEET_CHECKOUT/services/${s.name}/docker-compose.yml"`,
            safe: true,
          },
        });
      }
    }
    return out;
  },
});
