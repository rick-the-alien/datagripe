# Changelog

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
