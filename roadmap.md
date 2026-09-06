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

## Phase 11 — Gripes engine · planned

Designed in `docs/spec/gripes.md` (draft). The rule catalogue is
deliberately still open — the brand spec reserves it for its own pass.

- [ ] `packages/gripes`: pure rule catalogue, message catalogue, renderer
- [ ] Findings are analysis, wording is presentation — attitude re-renders,
      never re-analyses
- [ ] Client runner for statement/schema/object rules; server runner for
      execution rules
- [ ] Presentation: glyph margin, gripes panel, object-view annotations,
      annotation rail, status-bar count
- [ ] Dismissal at occurrence / target / project scope, never silent
- [ ] Catalogue assertions: four strings per rule, length caps, slur
      denylist at every level, every string interpolates a fact
- [ ] Blocked with the danger zone on project class + attitude leaving
      localStorage

## Unscheduled / parking lot
- SQLite type/nullability/default changes — need the 12-step table rebuild
- Index, constraint and trigger editing — the preview-then-apply shape is
  proven; the rest is dialect SQL
- Danger zone execution — blocked on project class leaving localStorage
  (`docs/spec/object-view.md` "Danger zone")
- AI query generation (explicit MVP non-goal; revisit after Phase 4)
- Arrow-based result transport (only after profiling JSON batches)
- Visual schema design, migration generation, DBA workflows
- SSH tunnels, cloud IAM auth, customer network agents
