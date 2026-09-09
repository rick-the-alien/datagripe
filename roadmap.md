# DataGripe roadmap

Single source of truth for what is planned, in progress, and shipped.
Update this file in the same change that starts or finishes a phase.
Dates are targets, not commitments.

Legend: `[ ]` planned · `[~]` in progress · `[x]` shipped

## Phase 0 — Foundation · shipped 2026-08-31

- [x] Bun workspaces monorepo (`apps/web`, `apps/server`, `packages/contracts`)
- [x] React 19 + Vite web shell with API/WebSocket proxy
- [x] Bun.serve API: config validation, structured logging, request IDs
- [x] PostgreSQL compose service, migration runner, initial schema
- [x] Shared Zod contracts: errors, WS protocol v1, documents, connections, executions
- [x] CI: typecheck, unit tests, migrations, web build

## Phase 1 — IDE shell · shipped 2026-08-31

- [x] Dockview workspace: movable tabs, horizontal/vertical splits
- [x] Monaco model registry: one model per document, split-safe editor views
- [x] Zustand document/view stores
- [x] IndexedDB draft + layout recovery (Dexie)
- [x] Spec: `docs/spec/editor-workspace.md`

Exit: multiple documents survive tab switching, splitting, and reload without lost changes.

## Phase 2 — PostgreSQL connections and explorer · shipped 2026-08-31

- [x] Encrypted connection CRUD (`connection_secrets`, AES-GCM, versioned keys)
- [x] DataGrip-style connection dialog: test, save, organize
- [x] Predefined connections from config/env — `docs/spec/connection-sources.md`
- [x] PostgreSQL adapter: lazy schema/table/column introspection
- [x] Explorer tree with refresh and short-lived introspection cache

Exit: a user can save a connection and browse schemas/tables/columns without seeing credentials.

## Phase 3 — Query execution · shipped 2026-08-31

- [x] Selection / statement-at-cursor / document execution
- [x] Execution registry, WebSocket lifecycle events, result batching
- [x] Data grid: columns, rows, duration, affected rows, truncation, errors
- [x] Server-enforced row/byte/timeout/concurrency limits
- [x] Reliable cancellation on a non-blocked control path
- [x] Query history metadata

Exit: queries run, stream bounded results, cancel reliably, and produce an auditable terminal state.

## Phase 4 — Product hardening · shipped 2026-08-31

- [x] Authentication provider + cookie sessions, CSRF, origin validation
- [x] Workspace RBAC via `workspace_members`
- [x] SSRF controls and deployment allowlists
- [x] Rate and concurrency limits
- [x] CSV/JSON export, keyboard-accessibility pass
- [x] Observability, backup/restore practice, load tests

Exit: production-readiness review passes for the intended deployment model.

## Phase 5 — Additional adapters · shipped 2026-08-31

- [x] MySQL adapter (`Bun.SQL`)
- [x] SQLite adapter where server-side file access fits deployment
- [x] Redis connection + command browser (`RedisClient`), distinct capability

Exit: adapters expose honest capability flags; no dialect leaks into generic UI state.

## Phase 6 — Multiplayer · shipped 2026-08-31

Tracked in `docs/spec/multiplayer.md`.

- [x] 6a: workspace-scoped shared documents (any member can open/edit/save)
- [x] 6b: presence — who is online, which document they have open
- [x] 6c: shared views — opt-in follow mode showing another member's cursor/selection
- [x] 6d: shared execution visibility — see what others ran and its results; run queries on shared connections under your own identity
- [x] 6e: audit trail for cross-user execution

## Phase 7 — Workspaces as projects · shipped 2026-09-01

- [x] Workspace create + switch (socket rebinds, everything rescopes)
- [x] Sidebar split: local scratchpads (IndexedDB) vs shared workspace files
- [x] Workspace default connection (document pick falls back to it)
- [x] Live `document.changed` broadcast for shared files
- [x] Spec: `docs/spec/workspaces.md`

## Phase 8 — Table view · shipped 2026-09-05

- [x] `table.rows` / `table.mutate` behind `ADAPTER_CAPABILITIES.tableData`
- [x] Real grid on double click: sort, `where …` filter, row-limit menu, paging
- [x] Editable cells, insert row, delete row — single-row writes in one transaction
- [x] Value panel for large/JSON cells, transpose, export shared with results
- [x] Spec: `docs/spec/table-view.md`

## Phase 9 — Object view · shipped 2026-09-05

- [x] `object.describe` behind `ADAPTER_CAPABILITIES.introspection === "sql"`
- [x] Seven structure tabs on real catalog data, one call fills them all
- [x] Per-engine DDL: verbatim on MySQL/SQLite, reconstructed on PostgreSQL
- [x] Tabs an engine cannot answer report themselves unsupported
- [x] Danger zone states real consequences; execution still deferred (see spec)
- [x] Spec: `docs/spec/object-view.md`

## Phase 10 — Structure editing and routines · shipped 2026-09-06

- [x] Routines and sequences in the object view; double click opens the ddl
- [x] PostgreSQL routine DDL is verbatim (`pg_get_functiondef`), overloads distinct
- [x] Editable columns tab: add, rename, retype, nullability, default, comment, drop
- [x] `object.alter` with `dryRun` — the SQL is reviewed before it runs
- [x] `columnChanges` capability so SQLite's narrow ALTER is honest, not broken
- [x] Middle click closes a tab
- [x] Spec: `docs/spec/object-view.md` (routines, "Editing columns")

## Phase 11 — Gripes engine · in progress

Designed in `docs/spec/gripes.md`.

- [x] `packages/gripes`: rule shape, runner, renderer, catalogue registry
- [x] `packages/contracts/src/gripes.ts`: severity, attitude, location,
      finding as wire types
- [x] `scanTokens` in sql-tools — comment/literal/quote-aware token walk,
      so a rule never fires on the word `join` inside a comment
- [x] Findings are analysis, wording is presentation — attitude re-renders,
      never re-analyses
- [x] Runner dispatches on declared inputs; a rule that throws costs its
      own output and nothing else
- [x] Catalogue assertions: four strings per rule with no fallback, length
      caps, barred terms at every level, notice profanity-free, id shape
- [x] Eleven rules — four blockers (definer-no-search-path,
      join.no-condition, delete/update.no-where), five warnings
      (subquery.not-in, view.select-star, index.not-concurrent,
      column.nullable-inequality, table.no-primary-key), two style
      (index.duplicate, routine.volatile-but-readonly) — each with a
      "looks like the finding and is not" fixture class
- [x] Client `SchemaInput` off the completion catalog: honest about what
      it does not know, and silent rather than guessing
- [x] `BARRED_TERMS` grows with the wording rather than gating it, and a
      plain-voice disclaimer beside the attitude control carries the rest
- [x] Client runner: debounced per document, offsets document-relative
- [x] Presentation: editor gutter glyph + squiggle, gripes panel with
      severity rows and auditable footers, status-bar count
- [x] Annotation rail on Monaco's overview ruler, capped at forty
- [x] Dismissal at occurrence / target / project scope, never silent —
      occurrence keys on a statement fingerprint, not a moving offset
- [x] Object-view annotations, tab-scoped, counted in the panel and
      status bar, with severity marks on the tab strip so a scoped
      finding cannot hide behind an unopened tab
- [x] Demo project: `scripts/demo/` seeds the objects and query files
      that exercise every rule, plus the silent counterexamples
- [ ] Server-side runner on the execution path
- [ ] Blocked with the danger zone on project class + attitude leaving
      localStorage

## Phase 12 — Domains · shipped 2026-09-07

Designed in `docs/spec/domains.md`. Replaces the hand-maintained
`pull_schema.sh` pattern: the object-to-domain map becomes data in the
app, and the directory tree it produces becomes a button.

- [x] `domains` + `domain_tags` + `domain_exports` (migration 0010),
      scoped to workspace × datasource, one domain per object, team-wide
- [x] `domain.list` / `upsert` / `delete` / `tag` and
      `packages/contracts/src/domains.ts`
- [x] Context-menu `domain ▸` submenu; Ctrl/Cmd click builds a
      multi-selection and the submenu applies to all of it
- [x] Colour rail on tree rows — eight palette slots, hues reserved for
      the brand pass, never the four project accents
- [x] Domain manager tab: colour, name, description, `include data`,
      delete with the untag count
- [x] Group-by-domain toggle with a permanent `untagged` bucket
- [x] `domain.export` — deterministic tree from object-view DDL, no
      external binary, dry run before prune, `HOST_FS_ROOTS` allowlist
      (optional; `HOST_FS_DISABLED` is the off switch) and `owner` role
- [x] Export directory set per datasource on its edit page
      (`datasource_export_paths`, migration 0012) — one path per project
      would have two datasources overwriting each other's tree
- [x] Per-object files carry their grants, `PUBLIC` written out
      explicitly so PostgreSQL's implicit `EXECUTE` default is visible
- [x] `domain.import` — the manifest round-trips tagging through git
- [x] Sync tab: target, plan, progress, refusals, and `domain_exports`
      run history in place of a parsed `pull_log.txt`
- [x] `domain.git` behind `DOMAIN_EXPORT_GIT` — argv not shell, `add`
      scoped to the domain root, push always a separate press, git's
      own stderr shown verbatim and no credential management
- [x] Datasource paths (`docs/spec/datasource-paths.md`, migration
      0013): `(name, directory)` pairs on the datasource page, each a
      sidebar section above the workspace files with a lazy file tree
- [x] A file opened from a path is a workspace document with an
      `origin` — live multiplayer state, and every save writes the file
      back to the checkout it came from
- [ ] Suggestions: glob patterns propose a domain, a person accepts it
- [ ] Stale-tag report in the manager; manual domain reordering

Exit: re-exporting an unchanged database produces an empty `git diff`,
and an object added since the last export shows up as untagged rather
than silently missing.

## Phase 13 — Access report · shipped 2026-09-07

Designed in `docs/spec/access-report.md`. The role × object matrix,
resolved rather than granted — which matters most under PostgREST,
where the grant graph is the API surface.

- [x] Effective privileges from `has_*_privilege`, with the ACL parse
      used only to explain *why* — `via PUBLIC`, `via member of …`,
      `owner`, `superuser`
- [x] Fixes the direct-grants blind spot the object view's grants tab
      still has: `information_schema.role_table_grants` cannot see a
      grant to `PUBLIC` or one inherited through a role. Asserted both
      ways in `accessData.test.ts`
- [x] Schema `USAGE` gates every cell, so the report never claims
      access a role does not have
- [x] RLS state, zero-policy tables, `security_invoker` views,
      `SECURITY DEFINER` routines, `pg_default_acl`, view dependencies
- [x] Per-datasource role set (`datasource_roles`, migration 0011) with
      untrusted and authenticator marks, suggested and never assumed
- [x] Seven `grant.*` rules in the gripes catalogue, loudest for
      `grant.public-execute` — the one nobody chose. The proposed
      eighth was dropped: it needed a judgement a rule cannot make
- [x] `access: <datasource>` tab, domain-filtered, "differences only"
- [x] `access/` in the domain dump, with no `Generated:` date in the
      body so a real change is not buried under a timestamp
- [ ] Render the per-column grant expansion (the data is already in the
      payload); a schema filter control; MySQL

Exit: a function created today shows `anon` reaching it via `PUBLIC`
before anybody has run a query against it.

## Phase 14 — Git datasources and markdown · shipped 2026-09-08

Designed in `docs/spec/git-datasources.md` and
`docs/spec/markdown-documents.md`. The repository becomes the datasource
definition, so a teammate who clones it gets the same connection, the
same sidebar sections and the same domains without configuring anything
— and the `.md` runbook that explains the database becomes something you
can read and run in place.

- [x] `.datagripe/` in the work tree root: `config.yaml` (connection,
      branding, path pairs — all repo-relative), `sync.yaml` (sync dir
      and export options), `domains.yaml` (generated)
- [x] `domains.yaml` replaces `manifest.json` everywhere, with a fixed
      YAML serialiser configuration so an unchanged export still diffs
      empty — line folding is the trap
- [x] Add by clone (into `GIT_REPOS_DIR`, SSRF-checked URL) or by
      adopting an existing checkout; `git_datasources` (migration 0014)
      is a pointer, never a copy of what the file says
- [x] `connectionSourceSchema` gains `"git"`; ids are `git:<uuid>` so
      nothing branches on id shape
- [x] Secrets stay `passwordEnv`; an unset variable lists the datasource
      and names the variable rather than hiding it. Inline `password:`
      is refused, not deprecated
- [x] `export config` on any managed/predefined datasource: generate,
      preview, write the `.datagripe/` set — never the password
- [x] Repository section in the left bar: branch, ahead/behind,
      porcelain rows with checkboxes, `commit…` / `push` / `pull` /
      `refresh`. Nothing is checked by default, nothing runs on a timer,
      and `pull` is `--ff-only`
- [x] `apps/server/src/domains/git.ts` → `apps/server/src/git/`, same
      argv-not-shell / fixed-verb-list / no-credential-management rules,
      new verbs. `GIT_ENABLED` gates it (`DOMAIN_EXPORT_GIT` still
      honoured)
- [x] After a pull, `repo.changed` re-runs the existing three-case disk
      check per open file-backed document; a pull that would touch a
      dirty one is refused
- [x] `documents.language` (migration 0015) with `sql | markdown`,
      decided by the name's extension in every files area
- [x] Markdown opens rendered (`marked`, raw HTML escaped, no image
      fetching); one bottom-right button flips to the editor and back,
      per view and persisted in the layout
- [x] `sql` fences are read-only Monaco blocks with a run button on the
      real `execution.start` path, analysed by the gripes runner at
      document offsets
- [x] In edit mode, completion and formatting delegate to the SQL
      providers inside a `sql` fence and return nothing outside one
- [x] The repo's path list is *mirrored* into `datasource_paths` rather
      than merged with it, so `file.list`, `file.open`, the document
      origin and archive-on-removal are the Phase 12 machinery untouched
- [x] `noPassword` in `config.yaml`, so a trust-auth cluster inside a
      checkout can be imported with nothing to configure
- [x] Repository commands (`docs/spec/repo-commands.md`, migration
      0016): `.datagripe/run.yaml` declares argv-form commands, gated by
      `REPO_COMMANDS_ENABLED` and by an explicit per-workspace approval
      of a hash of the command list. A change — including one a pull
      brought in — needs a fresh approval, because otherwise `git pull`
      is remote code execution
- [x] `background: true` for a service rather than a task: no deadline,
      a stop button, and it is in the hash so flipping it re-earns trust
- [x] Narrow environment (allowlist, not a filter), stdin ignored,
      SIGTERM then SIGKILL, output streamed to the workspace, argv in
      every audit line
- [x] `datagripe-example`: a repository that starts its own embedded
      PostgreSQL in the checkout and seeds it, and exercises every
      feature above
- [x] **Import is its own tab**, beside `new datasource` in the menu,
      and hands over to the datasource's own edit page on success —
      creating asks for a host and a password, importing asks for a URL,
      and one form holding both made people read the half that did not
      apply to them
- [x] An imported datasource's page is not dead: a locally stored
      password (winning over `passwordEnv`, never written to the repo)
      and `read only` / `show all schemas` overrides that reach the
      connection, not just the form (migration 0017)
- [ ] Branch switching, conflict resolution, hunk-level staging — all
      the points where a terminal is the better tool
- [ ] Followed cursors in view mode (`docs/spec/markdown-documents.md`
      "What is not built"); highlighting for non-SQL fences

Exit: clone `datagripe-example`, approve its commands, press **start
database**, and have a working project — schema, data, queries,
runbooks, domains — without configuring anything. Open a runbook, run
the query in it, tick a file in the repository section and commit it,
with nothing having been committed, pushed, pulled or executed that was
not pressed.

## Unscheduled / parking lot
- SQLite type/nullability/default changes — need the 12-step table rebuild
- Index, constraint and trigger editing — the preview-then-apply shape is
  proven; the rest is dialect SQL
- Danger zone execution — blocked on project class leaving localStorage
  (`docs/spec/object-view.md` "Danger zone")
- AI query generation (explicit MVP non-goal; revisit after Phase 4)
- Arrow-based result transport (only after profiling JSON batches)
- Visual schema design, DBA workflows
- Migration generation — the domain export is a structure snapshot, not
  an ordered rebuild (`docs/spec/domains.md` "What the export is not")
- SSH tunnels, cloud IAM auth, customer network agents
