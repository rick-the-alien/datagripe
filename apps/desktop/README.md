# DataGripe Desktop

Electrobun shell for the standalone desktop app. It spawns the DataGripe
server as a child process in embedded, direct-in mode (managed PostgreSQL
under the OS app-data dir, no accounts) and loads it in a frameless
window; the web app's header is the window drag region.

## How it works

- `src/main.ts` (Electrobun main process) picks a free port, spawns the
  server with `DATABASE_MODE=embedded`, `AUTH_DISABLED=true`,
  `EMBEDDED_PG_DATA_DIR=<userData>/pg` and `WEB_STATIC_DIR` pointing at
  the built web app, waits for `/health`, then opens a
  `titleBarStyle: "hidden"` window at `http://localhost:<port>/`.
- The web app is served by the server itself, so `/api` and `/ws` are
  same-origin and no web build changes are needed.
- Data lives in the OS app-data dir (e.g.
  `~/.local/share/app.datagripe.dev/<channel>/pg`), separate from any
  repo checkout.

## Which server it runs

First match wins:

1. `DATAGRIPE_SERVER_CMD` / `DATAGRIPE_SERVER_CMD_ARGS` — a custom
   command (e.g. an already-deployed server).
2. `DATAGRIPE_SERVER_ENTRY` — an absolute path to a server entry point.
3. **A checkout above the bundle**, run from source. This is what
   `hutch electrobun dev` gets, so changing the server is a restart
   rather than a rebuild.
4. **The bundled backend** in `Resources/app/server`, which is what a
   packaged build ships.

`DATAGRIPE_SERVER_RUNTIME` (default `bun`) picks what runs a source
entry point; the bundled backend always runs on the shell's own runtime,
because a packaged install has no `bun` on its PATH.

Standard server env (`DATABASE_MODE`, `APP_DATABASE_URL`,
`AUTH_DISABLED`, ...) passes through and wins over the desktop defaults.

## Develop

```bash
bun install
bun run --cwd apps/web build   # the dev shell serves apps/web/dist
cd apps/desktop
hutch electrobun dev           # builds the shell and opens the window
```

The Electrobun toolchain is Hutch-based (`npx electrobun ...` installs
`hutch` on first use); `hutch.config.ts` pins the Electrobun version.

## Packaged builds

```bash
bun run build   # stage the backend, then electrobun build --env=stable
```

`scripts/bundle-server.ts` stages everything the app needs to run with no
checkout beside it into `staged/` (whose two directories are tracked but
self-ignoring, because Electrobun's `copy` fails on a missing source):

```
staged/server/index.js          the server, bundled with bun build
staged/server/migrations/*.sql  applied at first boot
staged/server/web/              apps/web/dist, served by the server
staged/pg/{bin,lib,share}       the PostgreSQL binaries
```

`electrobun.config.ts` copies those into `Resources/app/server` and
`Resources/app/pg`, beside the shell's own `bun/index.js`. Only the host
platform's PostgreSQL is staged — desktop builds are per-platform.

Three things resist bundling and are handled explicitly:

- **The installer's tar reader rejects paths over 100 characters**
  (`TarUnsupportedFileType`, at install time, on someone else's
  machine). That is why PostgreSQL sits at the top of the bundle under a
  two-letter name instead of inside `staged/server/node_modules/
  @embedded-postgres/linux-x64/`, which overshoots by 40 characters. The
  staging step fails the build if anything crosses the line.
- **`@embedded-postgres/<platform>` derives its binary paths from its own
  `import.meta.url`**, which bundling rewrites to the bundle's location.
  A build-time plugin replaces that module with the three paths it
  exports, resolved against `../pg` (or `DATAGRIPE_PG_DIR`).
- **Electrobun's `copy` follows symlinks**, and `native/lib` has three
  names for every shared library, so ICU's 27MB data file would land
  three times. The staging step collapses each chain onto the SONAME the
  loader asks for.

## Icon

`icon.png` is a copy of `brand/app-icon/icon.png`, written by
`bun run sync:brand` — do not edit it here. It is rendered from
`brand/app-icon/icon.svg` by `bun run brand:render`; see
[brand/README.md](../../brand/README.md).

`build.linux.icon` points Electrobun at it; Electrobun copies it to
`Resources/appIcon.png` and writes `Icon=appIcon` into the generated
`.desktop` entry, which the installer rewrites to the installed absolute
path. Without the setting the entry has no `Icon=` line at all and the
launcher shows a broken image. 256x256 because that is the `hicolor`
directory Electrobun's Flatpak recipe installs it into.

macOS wants an `icon.iconset` directory and Electrobun 2.0.1 has no
Windows icon setting — both still to do.
