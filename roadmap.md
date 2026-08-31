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

## Phase 1 — IDE shell

- [ ] Dockview workspace: movable tabs, horizontal/vertical splits
- [ ] Monaco model registry: one model per document, split-safe editor views
- [ ] Zustand document/view stores
- [ ] IndexedDB draft + layout recovery (Dexie)
- [ ] Spec: `docs/spec/editor-workspace.md`

Exit: multiple documents survive tab switching, splitting, and reload without lost changes.

## Phase 2 — PostgreSQL connections and explorer

- [ ] Encrypted connection CRUD (`connection_secrets`, AES-GCM, versioned keys)
- [ ] DataGrip-style connection dialog: test, save, organize
- [ ] Predefined connections from config/env — `docs/spec/connection-sources.md`
- [ ] PostgreSQL adapter: lazy schema/table/column introspection
- [ ] Explorer tree with refresh and short-lived introspection cache

Exit: a user can save a connection and browse schemas/tables/columns without seeing credentials.

## Phase 3 — Query execution

- [ ] Selection / statement-at-cursor / document execution
- [ ] Execution registry, WebSocket lifecycle events, result batching
- [ ] Data grid: columns, rows, duration, affected rows, truncation, errors
- [ ] Server-enforced row/byte/timeout/concurrency limits
- [ ] Reliable cancellation on a non-blocked control path
- [ ] Query history metadata

Exit: queries run, stream bounded results, cancel reliably, and produce an auditable terminal state.

## Phase 4 — Product hardening

- [ ] Authentication provider + cookie sessions, CSRF, origin validation
- [ ] Workspace RBAC via `workspace_members`
- [ ] SSRF controls and deployment allowlists
- [ ] Rate and concurrency limits
- [ ] CSV/JSON export, keyboard-accessibility pass
- [ ] Observability, backup/restore practice, load tests

Exit: production-readiness review passes for the intended deployment model.

## Phase 5 — Additional adapters

- [ ] MySQL adapter (`Bun.SQL`)
- [ ] SQLite adapter where server-side file access fits deployment
- [ ] Redis connection + command browser (`RedisClient`), distinct capability

Exit: adapters expose honest capability flags; no dialect leaks into generic UI state.

## Phase 6 — Multiplayer (staged)

Tracked in `docs/spec/multiplayer.md`. Explicitly post-MVP.

- [ ] 6a: workspace-scoped shared documents (any member can open/edit/save)
- [ ] 6b: presence — who is online, which document they have open
- [ ] 6c: shared views — opt-in follow mode showing another member's cursor/selection
- [ ] 6d: shared execution visibility — see what others ran and its results; run queries on shared connections under your own identity
- [ ] 6e: audit trail for cross-user execution

## Unscheduled / parking lot

- AI query generation (explicit MVP non-goal; revisit after Phase 4)
- Arrow-based result transport (only after profiling JSON batches)
- Visual schema design, migration generation, DBA workflows
- SSH tunnels, cloud IAM auth, customer network agents
