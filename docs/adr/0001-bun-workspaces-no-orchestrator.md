# ADR 0001 — Monorepo toolchain: Bun workspaces, no orchestrator

**Status:** accepted
**Date:** 2026-08-31

## Context

DataGripe needs shared types between a Bun server and a Vite/React browser
app (`packages/contracts`), plus future adapter and SQL-parsing packages.
The initial idea doc (`docs/initial_idea.md` §2) chose Bun workspaces and
explicitly deferred larger build orchestration (Turborepo/Nx).

## Decision

Use Bun workspaces with three packages (`apps/web`, `apps/server`,
`packages/contracts`). Contracts are consumed as TypeScript source via path
exports (`"@datagripe/contracts": "*"` in dependents) — no build step for
the package. Root scripts use `bun run --filter` / `--parallel`; the single
`bun run dev` command filters to `./apps/*` so packages without a `dev`
script (contracts) don't break it.

## Consequences

- Contract changes are instantly visible to both apps; no watch/build for
  `packages/*`.
- No caching/graph orchestration; acceptable at this size, revisit if CI
  time becomes painful.
- `bun run --filter './apps/*' --parallel dev` is load-bearing: adding a new
  app under `apps/` automatically joins `dev`.
- Bun only auto-loads `.env` from the process cwd; `loadConfig` merges the
  repository-root `.env` for missing keys so `--cwd` scripts behave
  identically to root-run ones.
