# DataGripe Desktop

Electrobun shell for the standalone desktop app. It spawns the DataGripe
server as a child process in embedded, direct-in mode (managed PostgreSQL
under the OS app-data dir, no accounts) and loads it in a frameless
window; the web app's header is the window drag region.

## How it works

- `src/main.ts` (Electrobun main process) picks a free port, spawns
  `bun run apps/server/src/index.ts` with `DATABASE_MODE=embedded`,
  `AUTH_DISABLED=true`, `EMBEDDED_PG_DATA_DIR=<userData>/pg`, and
  `WEB_STATIC_DIR=<repo>/apps/web/dist`, waits for `/health`, then opens a
  `titleBarStyle: "hidden"` window at `http://localhost:<port>/`.
- The web app is served by the server itself, so `/api` and `/ws` are
  same-origin and no web build changes are needed.
- Data lives in the OS app-data dir (e.g.
  `~/.local/share/app.datagripe.dev/<channel>/pg`), separate from any
  repo checkout.

## Develop

```bash
bun install
bun run --cwd apps/web build   # the shell serves apps/web/dist
cd apps/desktop
hutch electrobun dev           # builds the shell and opens the window
```

The Electrobun toolchain is Hutch-based (`npx electrobun ...` installs
`hutch` on first use); `hutch.config.ts` pins the Electrobun version.

## Backend overrides

- `DATAGRIPE_SERVER_ENTRY` — absolute path to the server entry when the
  monorepo layout isn't found by walking up from the bundle.
- `DATAGRIPE_SERVER_CMD` / `DATAGRIPE_SERVER_CMD_ARGS` — run the backend
  with a custom command instead (e.g. a bundled runtime in packaged
  builds).
- Standard server env (`DATABASE_MODE`, `APP_DATABASE_URL`,
  `AUTH_DISABLED`, ...) passes through and wins over the desktop
  defaults.

## Packaging status

`hutch electrobun build` produces a working shell installer under
`build/`, but the packaged bundle does not yet embed the backend: it
expects the monorepo beside the install (dev layout) or
`DATAGRIPE_SERVER_CMD` pointing at a deployed server. Bundling the server
plus the embedded-postgres native binaries into `Resources/` is the
remaining packaging work.
