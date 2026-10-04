/**
 * Skills: vendored in the config repo's skills/ directory (one directory per
 * skill, with a SKILL.md), linked into a store, and from the store into each
 * client's skills directory.
 *
 *   [skills]
 *   store = "~/.agents/skills"          # links to <repo>/skills/<name>
 *   clients = ["~/.claude/skills"]      # links to <store>/<name>
 *   watch = ["~/.codex/skills"]         # only checked for stray installs
 *   ignore = ["synced"]                 # names T3 Fleet leaves alone
 *
 * A skill installed outside T3 Fleet (a real directory with a SKILL.md) is a
 * stray. It is not deleted: the fix proposes it for the repo, where an
 * authority approves it (t3-fleet skills adopt).
 *
 * A real directory where a link belongs is kept as a backup under
 * ~/.local/state/t3-fleet/skill-backups, outside every directory scanned for
 * strays, so it never comes back as a skill of its own.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { defineArea, sh, shPath } from "../Area.ts";
import { expandHome } from "../Config.ts";
import { SH_STATE_DIR } from "../Names.ts";
import type { Finding } from "../Diagnose.ts";

export const Desired = Schema.UndefinedOr(
  Schema.Struct({
    store: Schema.optionalKey(Schema.String),
    clients: Schema.optionalKey(Schema.Array(Schema.String)),
    watch: Schema.optionalKey(Schema.Array(Schema.String)),
    ignore: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);

/** A backup an older T3 Fleet left beside the skill it replaced (<name>.t3-fleet-backup.<time>): never a skill. */
export const isSkillBackup = (name: string) => /\.t3-fleet-backup(\.|$)/.test(name);

export const LinkState = Schema.Literals(["ok", "missing", "wrong", "real-dir"]);

export const Observed = Schema.Struct({
  store: Schema.String,
  /** Skills in the repo. */
  vendored: Schema.Array(Schema.String),
  /** Per vendored skill: its store link, and its link in each client dir. */
  links: Schema.Array(
    Schema.Struct({ skill: Schema.String, dir: Schema.String, state: LinkState }),
  ),
  /** Real skill directories no repo skill accounts for: name and where. */
  strays: Schema.Array(Schema.Struct({ skill: Schema.String, dir: Schema.String })),
  /** Links into the store or repo that point at nothing. */
  dangling: Schema.Array(Schema.Struct({ skill: Schema.String, dir: Schema.String })),
});

export const SkillsArea = defineArea({
  id: "skills",
  description: "skills vendored in the repo, linked into the store and each client",
  desired: Desired,
  observed: Observed,
  observe: (desired, ctx) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const exists = (p: string) => fs.exists(p).pipe(Effect.orElseSucceed(() => false));
      const list = (dir: string) =>
        fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => [] as Array<string>));
      const store = expandHome(desired?.store ?? "~/.agents/skills", ctx.home);
      const clients = (desired?.clients ?? []).map((c) => expandHome(c, ctx.home));
      const watch = (desired?.watch ?? []).map((c) => expandHome(c, ctx.home));
      const ignore = new Set(desired?.ignore ?? []);
      const repoSkills = path.join(ctx.checkout, "skills");

      const vendored: Array<string> = [];
      for (const name of (yield* list(repoSkills)).sort()) {
        if (name.startsWith(".") || isSkillBackup(name)) continue;
        if (yield* exists(path.join(repoSkills, name, "SKILL.md"))) vendored.push(name);
      }

      const linkState = (at: string, want: string) =>
        Effect.gen(function* () {
          const link = yield* fs.readLink(at).pipe(Effect.option);
          if (Option.isNone(link))
            return (yield* exists(at)) ? ("real-dir" as const) : ("missing" as const);
          const real = yield* fs.realPath(at).pipe(Effect.orElseSucceed(() => ""));
          const wanted = yield* fs.realPath(want).pipe(Effect.orElseSucceed(() => want));
          return real === wanted ? ("ok" as const) : ("wrong" as const);
        });

      const links: Array<(typeof Observed.Type)["links"][number]> = [];
      for (const skill of vendored) {
        if (ignore.has(skill)) continue;
        links.push({
          skill,
          dir: store,
          state: yield* linkState(path.join(store, skill), path.join(repoSkills, skill)),
        });
        for (const client of clients) {
          links.push({
            skill,
            dir: client,
            state: yield* linkState(path.join(client, skill), path.join(repoSkills, skill)),
          });
        }
      }

      const strays: Array<{ skill: string; dir: string }> = [];
      const dangling: Array<{ skill: string; dir: string }> = [];
      for (const dir of [store, ...clients, ...watch]) {
        for (const name of yield* list(dir)) {
          if (name.startsWith(".") || ignore.has(name) || isSkillBackup(name)) continue;
          const at = path.join(dir, name);
          const link = yield* fs.readLink(at).pipe(Effect.option);
          if (Option.isSome(link)) {
            if (!(yield* exists(at))) dangling.push({ skill: name, dir });
            continue;
          }
          if (!vendored.includes(name) && (yield* exists(path.join(at, "SKILL.md"))))
            strays.push({ skill: name, dir });
        }
      }
      return { store, vendored, links, strays, dangling };
    }),
  diagnose: ({ node, desired, observed }) => {
    const out: Array<Finding> = [];
    const storeConfigured = desired?.store ?? "~/.agents/skills";
    const tilde = (dir: string) =>
      dir.replace(/^\/(Users|home)\/[^/]+\//, "~/").replace(/^\/root\//, "~/");
    const broken = observed.links.filter((l) => l.state !== "ok");
    if (broken.length > 0) {
      const commands: Array<string> = [];
      if (broken.some((l) => l.state === "real-dir")) {
        commands.push(`backups="${SH_STATE_DIR}/skill-backups/$(date +%Y%m%d%H%M%S)"`);
      }
      for (const l of broken) {
        const isStore = l.dir === observed.store;
        const at = `${shPath(tilde(l.dir))}/${sh(l.skill)}`;
        const target = isStore
          ? `"$T3_FLEET_CHECKOUT/skills/${l.skill}"`
          : `${shPath(storeConfigured)}/${sh(l.skill)}`;
        // One backup directory per client directory, named after it: ~/.claude/skills → .claude-skills.
        const backup = `"$backups"/${sh(tilde(l.dir).replace(/^~\/?/, "").replaceAll("/", "-") || "home")}`;
        const aside = l.state === "real-dir" ? `mkdir -p ${backup} && mv ${at} ${backup}/ && ` : "";
        commands.push(`mkdir -p ${shPath(tilde(l.dir))} && ${aside}ln -sfn ${target} ${at}`);
      }
      const skills = [...new Set(broken.map((l) => l.skill))];
      out.push({
        node,
        key: "skills-unlinked",
        severity: "warn",
        area: "skills",
        title: `${skills.length} skill${skills.length === 1 ? " is" : "s are"} not linked into place: ${skills.slice(0, 5).join(", ")}${skills.length > 5 ? ", …" : ""}`,
        ...(broken.some((l) => l.state === "real-dir")
          ? {
              detail:
                "real directories in the way are kept in ~/.local/state/t3-fleet/skill-backups",
            }
          : {}),
        fix: { command: commands.join("\n"), safe: true },
      });
    }
    if (observed.dangling.length > 0) {
      out.push({
        node,
        key: "skills-dangling",
        severity: "warn",
        area: "skills",
        title: `${observed.dangling.length} skill link${observed.dangling.length === 1 ? " points" : "s point"} at nothing: ${observed.dangling.map((d) => d.skill).join(", ")}`,
        fix: {
          command: observed.dangling
            .map((d) => `rm ${shPath(tilde(d.dir))}/${sh(d.skill)}`)
            .join("\n"),
          safe: true,
        },
      });
    }
    for (const stray of observed.strays) {
      out.push({
        node,
        key: `skill-stray-${stray.skill}`,
        severity: "warn",
        area: "skills",
        title: `skill ${stray.skill} was installed in ${tilde(stray.dir)} outside T3 Fleet`,
        detail:
          "proposing it puts it in the repo for an authority to approve; the original is moved aside, not deleted",
        fix: {
          command: `t3-fleet skills adopt ${sh(stray.skill)} --from ${shPath(tilde(stray.dir))}`,
          safe: true,
        },
      });
    }
    return out;
  },
});
