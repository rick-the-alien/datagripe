# Changelog

## Unreleased

### Added

- **A datasource can carry `search_path`.** PostgreSQL runtime parameters
  are sent in the startup packet, so an unqualified name resolves in the
  schemas the datasource names instead of every query having to say so.
  `application_name` comes with the same mechanism, and shows up in
  `pg_stat_activity`. A pasted connection string carrying either now
  keeps it rather than reporting that it could not.

  An allowlist rather than free-form name/value pairs, because an
  unrecognised parameter in the startup packet is a connect-time FATAL
  rather than a warning — a typed-in name would be a datasource that
  cannot connect at all, reporting a parameter instead of the field it
  came from. `statement_timeout`, `client_encoding` and
  `default_transaction_read_only` are refused by name with the reason.

  They travel into `.datagripe/config.yaml` on export, so a teammate who
  clones the repository resolves names the same way. They are not
  secrets, and the form says so.

## 0.0.4 — 2026-09-10

### Fixed

- **The desktop app can reach its own update manifest.** Every check since
  the updater shipped failed with `unable to get local issuer
  certificate`: the bundled runtime does not find the system's
  certificate authorities on its own, while the system Bun on the same
  machine fetches the same URL fine. It is pointed at them now, before
  anything reaches the network — the server inherits it too, and needs it
  for the same reason. 0.0.2 and 0.0.3 cannot update themselves; 0.0.4
  has to be installed by hand, and updates work from there.
- **The update dialog no longer says "0.0.3 is available" to someone
  running 0.0.3.** Updates are compared by build hash, so two builds can
  share a version; when they do, the dialog names the builds instead.

## 0.0.3 — 2026-09-10

### Added

- **Paste a connection string to create a datasource.** A box above the
  engine picker on the new-datasource form reads a provider's URL —
  scheme, host, port, database, user, password, `sslmode` — and fills the
  fields in for you to check. Parsed in the browser; the string itself is
  never sent anywhere. Anything it cannot honour is named underneath with
  the reason, so nothing is dropped in silence — `channel_binding` has no
  option in this driver, and runtime parameters like `application_name`
  and `search_path` have nowhere to live until a datasource can carry
  them.
- **`verify-ca` joins the TLS modes**, so a pasted `sslmode` has somewhere
  to land. libpq's `allow` and `prefer` deliberately do not: measured
  against a non-TLS PostgreSQL, both hang until the connection timeout
  because the driver has no negotiated fallback, so a pasted one is raised
  to `require` and you are told.
- **A setting for the blank window on some Linux GPUs.**
  `disableDmabufRenderer` in `settings.json` beside the data directory,
  for when WebKit cannot allocate a DMABUF buffer and the app opens as an
  empty rectangle. Previously fixable only by launching from a terminal
  with an environment variable, which the desktop icon cannot do.
- **[docs/moving-a-datasource.md](docs/moving-a-datasource.md)** — how to
  export a datasource into git and import it on another machine, and
  where the password lives instead of in the repository.

### Fixed

- **Quitting the desktop app no longer leaves its database running.**
  Closing the window quits Electrobun natively, without running a Bun
  exit handler, so the shell never signalled the server it had spawned —
  the server outlived the app, the embedded PostgreSQL kept its lock on
  the data directory, and the next launch could not start its own and
  never opened. The shell now stops the server from `before-quit`, which
  every quit path passes through.
- **A cluster left behind by a crash no longer bricks the app.** The
  server adopts a postmaster already serving its data directory instead
  of failing to start beside it, and stops it on the way out — including
  from an exit handler, which is the only thing that runs when shutdown
  is cut short.

## 0.0.2 — 2026-09-09

### Fixed

- **The packaged desktop app now runs.** It expected a monorepo checkout
  beside the install and died at startup looking for
  `apps/server/src/index.ts`. `apps/desktop/scripts/bundle-server.ts` now
  stages the backend — the server bundled with `bun build`, its
  migrations, the built web app and the PostgreSQL binaries — into the
  bundle, and the shell runs that when there is no checkout to run from.
  Build packaged desktop apps with `bun run build` in `apps/desktop`;
  `electrobun build` on its own skips the staging step.
- **The launcher no longer shows a broken icon.** The generated
  `.desktop` entry had no `Icon=` line, because Electrobun's
  `build.linux.icon` was never set and no icon shipped with the app.

- **The desktop app checks for its own updates.** It asks 10 seconds
  after launch and every six hours after, offers the new version in a
  dialog, and on acceptance downloads it, stops the server and restarts
  into it. Electrobun had shipped the updater and the build had been
  writing an update manifest all along; nothing pointed at a URL, nothing
  published the manifest, and nothing ever asked.
  `DATAGRIPE_DISABLE_UPDATES=true` turns it off.

### Changed

- **The shipped brand assets live in `brand/`.** The app icon and the
  painted mascot set had been sitting in `apps/web/public/`, hand-copied
  into `site/`. `brand/app-icon/icon.svg` is now the drawing everything
  else comes from: `bun run brand:render` rasterises it into the sizes
  the platforms ask for, `bun run sync:brand` copies the results into
  `apps/` and `site/`, and CI fails if a copy drifts. The desktop, the
  PWA and the landing page now show the same mark, and the placeholder
  cylinder favicon is retired.

## 0.0.1 — 2026-09-07

First tagged release. Version zero in the honest sense: it works, it is
tested, and nothing in it is promised to stay put.

### What is in it

A web-based database IDE — Bun, React 19, TypeScript.

- **Editor workspace.** Movable tabs and splits (Dockview), one Monaco
  model per document, drafts and layout recovered from IndexedDB across
  reloads.
- **Connections and explorer.** Encrypted connection storage (AES-GCM,
  versioned keys), predefined connections from config, lazy
  schema/table/column introspection.
- **Query execution.** Run a selection, the statement at the cursor, or
  a whole document; streamed bounded results, reliable cancellation,
  server-enforced row/byte/timeout/concurrency limits, CSV and JSON
  export.
- **Adapters.** PostgreSQL, MySQL, SQLite, and Redis, each declaring
  what it can actually do through `ADAPTER_CAPABILITIES` — the UI gates
  on capability flags, never on an adapter id.
- **Table view.** Sort, filter, page, edit cells, insert and delete
  rows, a value panel for large and JSON cells, and transpose.
- **Object view.** Seven structure tabs from one catalog call, per-engine
  DDL, an editable columns tab (add, rename, retype, nullability,
  default, comment, drop) with `dryRun` so the SQL is reviewed before it
  runs.
- **Multiplayer.** Shared workspace documents, presence, follow mode,
  shared execution visibility under your own identity, and an audit
  trail.
- **Projects.** Workspace create and switch, local scratchpads separate
  from shared files, a per-project default connection.
- **Gripes.** Eleven static-analysis rules over your SQL and your
  schema, at four attitude levels, dismissible per occurrence, per
  target, or per project. Findings are analysis and wording is
  presentation, so changing the attitude re-renders and never
  re-analyses.
- **Shipping.** Installable PWA, and an Electrobun desktop shell that
  runs its own embedded PostgreSQL.

### What is not in it

- The object view's **danger zone** states consequences but does not
  execute: truncate and drop are deliberately unimplemented.
- Gripes run in the client only. The **server-side runner** on the
  execution path is designed and not built, so there are no rules about
  how a query actually turned out.
- **Project class and attitude live in `localStorage`**, marked as a
  mock. Both need to move server-side before they can be trusted, which
  is what the danger zone is waiting on.
- Nothing analyses the text on the **DDL tab**, so a view created with
  `select *` is flagged in a query file but not on the view itself.

### Trying it

`bun install && bun run dev` starts an embedded PostgreSQL and opens
without a login. `scripts/demo/` seeds a project whose files and objects
trip every gripe rule, alongside the cases that look like findings and
are deliberately silent.
