/**
 * Codex plugins a node should have installed:
 *
 *   [codex]
 *   plugins = ["figma@openai-curated"]      # name@marketplace
 *
 * Plugins installed from a remote marketplace are missing from
 * `codex plugin list`, so their cache directory also counts as installed;
 * without that, every sync would reinstall them. Plugins not listed are left
 * alone.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { defineArea, sh } from "../Area.ts";
import type { Finding } from "../Diagnose.ts";
import { exec } from "../Exec.ts";

const Listed = Schema.Struct({
  installed: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String }))),
});

export const CodexPluginsArea = defineArea({
  id: "codex",
  description: "Codex plugins installed on each node",
  desired: Schema.UndefinedOr(
    Schema.Struct({ plugins: Schema.optionalKey(Schema.Array(Schema.String)) }),
  ),
  observed: Schema.Struct({ codex: Schema.Boolean, missing: Schema.Array(Schema.String) }),
  observe: (desired, ctx) =>
    Effect.gen(function* () {
      const wanted = desired?.plugins ?? [];
      if (wanted.length === 0) return { codex: false, missing: [] };
      const fs = yield* FileSystem.FileSystem;
      const list = yield* exec({
        command: "codex",
        args: ["plugin", "list", "--json"],
        env: ctx.env,
        timeout: Duration.seconds(30),
      });
      if (list.code !== 0) return { codex: false, missing: [] };
      const names = Option.match(Schema.decodeOption(Schema.fromJsonString(Listed))(list.stdout), {
        onNone: () => [] as Array<string>,
        onSome: (l) => (l.installed ?? []).map((p) => p.name),
      });
      const codexHome = ctx.env["CODEX_HOME"] ?? `${ctx.home}/.codex`;
      const missing: Array<string> = [];
      for (const selector of wanted) {
        const [name = selector, market] = selector.split("@");
        if (names.includes(name)) continue;
        if (
          market !== undefined &&
          (yield* fs
            .exists(`${codexHome}/plugins/cache/${market}/${name}`)
            .pipe(Effect.orElseSucceed(() => false)))
        )
          continue;
        missing.push(selector);
      }
      return { codex: true, missing };
    }),
  diagnose: ({ node, observed }) => {
    const out: Array<Finding> = [];
    if (observed.missing.length === 0) return out;
    out.push({
      node,
      key: "codex-plugins-missing",
      severity: "warn",
      area: "codex",
      title: `Codex plugins missing: ${observed.missing.join(", ")}`,
      fix: {
        command: observed.missing
          .map((p) => `codex plugin add ${sh(p)} --json >/dev/null`)
          .join("\n"),
        safe: true,
      },
    });
    return out;
  },
});
