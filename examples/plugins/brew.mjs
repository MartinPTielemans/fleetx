/**
 * Example plugin area: Homebrew formulae every macOS node should have.
 *
 *   # t3-fleet.toml
 *   [plugins]
 *   areas = ["plugins/brew.mjs"]
 *
 *   # nodes/laptop.toml (or a profile)
 *   brew = ["gh", "jq"]
 *
 * A plugin imports nothing: T3 Fleet passes in everything it needs.
 */
export default ({ defineArea, Effect, Schema, Duration, exec, sh }) =>
  defineArea({
    id: "brew",
    description: "Homebrew formulae installed on macOS nodes",
    desired: Schema.UndefinedOr(Schema.Array(Schema.String)),
    observed: Schema.Struct({ brew: Schema.Boolean, installed: Schema.Array(Schema.String) }),
    observe: (wanted, ctx) =>
      Effect.gen(function* () {
        if ((wanted ?? []).length === 0) return { brew: false, installed: [] };
        const list = yield* exec({
          command: "brew",
          args: ["list", "--formula", "-1"],
          env: ctx.env,
          timeout: Duration.seconds(30),
        });
        return { brew: list.code === 0, installed: list.stdout.split("\n").filter(Boolean) };
      }),
    diagnose: ({ node, desired, observed }) => {
      const missing = (desired ?? []).filter((f) => !observed.installed.includes(f));
      if (!observed.brew || missing.length === 0) return [];
      return [
        {
          node,
          key: "brew-missing",
          severity: "warn",
          area: "brew",
          title: `Homebrew formulae missing: ${missing.join(", ")}`,
          fix: { command: `brew install ${missing.map(sh).join(" ")}`, safe: true },
        },
      ];
    },
  });
