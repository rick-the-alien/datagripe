# DataGripe

A web-based database IDE inspired by DataGrip. Bun + React 19 + TypeScript.

## Quickstart

Personal/local use — zero config, no Docker, no accounts:

```bash
bun install
bun run dev                     # web on :5173, api on :3001
```

The server starts its own embedded PostgreSQL cluster (data in
`./data/pg`), migrates it automatically, and runs direct-in without
login. Open http://localhost:5173 and you're in.

Shared/external PostgreSQL (e.g. the compose setup):

```bash
bun install
docker compose up -d postgres   # or any local Postgres; see .env.example
cp .env.example .env            # sets APP_DATABASE_URL + the two secrets
bun run db:migrate
bun run dev                     # web on :5173, api on :3001, login enabled
```

Setting `APP_DATABASE_URL` selects external mode: account auth is on and
`CONNECTION_ENCRYPTION_KEY`/`SESSION_SECRET` are required. See
[.env.example](.env.example) for every knob (`DATABASE_MODE`,
`AUTH_DISABLED`, `EMBEDDED_PG_*`, `WEB_STATIC_DIR`).

Requires Bun 1.4 (`packageManager` is pinned). External mode expects
PostgreSQL 17.

## Desktop app

An Electrobun shell lives in [apps/desktop](apps/desktop): it spawns the
server in embedded, direct-in mode (data under the OS app-data dir) and
loads it in a frameless window — the web app's header is the drag region.

```bash
bun run --cwd apps/web build    # the desktop shell serves apps/web/dist
cd apps/desktop
hutch electrobun dev            # dev build, opens the window
hutch electrobun build          # packaged build under build/
```

The web app is also an installable PWA (`bun run --cwd apps/web build` +
any static host, or `WEB_STATIC_DIR` on the server): frameless via
`window-controls-overlay`, with an update-available refresh button in the
status bar.

Pushing a `v*` tag builds the web bundle and the desktop shell for
Linux, macOS, and Windows and attaches them to a GitHub release (see
[.github/workflows/release.yml](.github/workflows/release.yml)).

## Documentation

- [roadmap.md](roadmap.md) — phases, progress, scheduling
- [docs/initial_idea.md](docs/initial_idea.md) — original engineering handoff
- [docs/adr/](docs/adr/) — architecture decision records
- [docs/spec/](docs/spec/) — feature/subsystem specifications
- [docs/rfc/](docs/rfc/) — proposals under discussion

Documentation is updated in the same change as the behavior it describes;
see [docs/README.md](docs/README.md) for conventions.
