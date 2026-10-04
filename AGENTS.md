# Working in T3 Fleet

T3 Fleet keeps every T3 Code environment equivalent. It is a companion to T3
Code, written so its packages could move into T3's monorepo: same stack
(TypeScript 7, Effect 4 rc.115, Node 24, pnpm 11, vite-plus), same
conventions, and the Effect language service's rules are errors here too.

- `packages/core` is the engine; `apps/cli` is the `t3-fleet` command.
- `packages/core/src/vendor/t3/` is copied from T3 Code at a pinned commit.
  Never edit it; refresh it with `scripts/vendor-t3.sh`.
- Probes are read-only. Anything that changes a machine is a fix, shown before
  it runs.
- Use T3's own interfaces (its CLI, its HTTP descriptor) instead of reading or
  writing its files, wherever T3 offers one.

Checks: `pnpm typecheck`, `pnpm test`. Try it against real machines with
`pnpm --filter t3-fleet build && node apps/cli/dist/bin.mjs status`.
