# DataGripe

A web-based database IDE inspired by DataGrip. Bun + React 19 + TypeScript.

## Quickstart

```bash
bun install
docker compose up -d postgres   # or any local Postgres; see .env.example
cp .env.example .env            # set real values for the two secrets
bun run db:migrate
bun run dev                     # web on :5173, api on :3001
```

Requires Bun 1.4 (`packageManager` is pinned) and a local PostgreSQL 17.

## Documentation

- [roadmap.md](roadmap.md) — phases, progress, scheduling
- [docs/initial_idea.md](docs/initial_idea.md) — original engineering handoff
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/spec/](docs/spec/) — feature/subsystem specifications
- [docs/rfc/](docs/rfc/) — proposals under discussion

Documentation is updated in the same change as the behavior it describes;
see [docs/README.md](docs/README.md) for conventions.
