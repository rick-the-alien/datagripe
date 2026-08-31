# Spec — Query execution

**Status:** current
**Phase:** 3
**Supersedes:** nothing (implements `docs/initial_idea.md` §7, §10)

## Goal

Run SQL from the editor — a selection, the statement at the cursor, or a
whole document — with server-enforced limits, reliable cancellation, live
result streaming into a data grid, and an auditable history record for
every execution.

## Non-goals

- Multi-result-set tabs (a document's result sets stream in order; the
  grid shows the latest, the status line counts statements).
- Result export (Phase 4).
- Execution resume after browser disconnect beyond in-memory replay
  (`execution.subscribe` replays buffered events; no durable result
  storage — initial_idea.md §8).
- Collaborative execution visibility (Phase 6).

## Design

### Statement handling

`packages/sql-tools` splits SQL text into statements (quotes, nested
block comments, dollar-quoted bodies, semicolons) and locates the
statement at a cursor offset. The client uses it for run modes; the
server splits again before execution so every statement boundary is
authoritative server-side.

Run modes (window-level shortcuts, routed to the focused editor view —
the same routing as Ctrl/Cmd+S, see `docs/spec/editor-workspace.md`):

| Shortcut | Mode |
| --- | --- |
| Ctrl/Cmd+Enter | Selection if non-empty, else statement at cursor |
| Ctrl/Cmd+Shift+Enter | Whole document |

One `execution.start` carries the text (one or many statements). The
server splits it and runs statements sequentially on one reserved target
connection, in autocommit-per-statement mode.

### Server execution flow

1. Validate payload; resolve the connection (managed: decrypt;
   predefined: in-memory) — never exposed to the client.
2. Concurrency limit: running executions per user ≥
   `MAX_CONCURRENT_QUERIES_PER_USER` → `RATE_LIMITED`.
3. Registry entry (`queued`) + `query_executions` history row
   (sha256 `query_hash`, 200-char `preview`).
4. Reserve a target connection; `SET statement_timeout` and, for
   read-only connections, `SET default_transaction_read_only = on`;
   register `pg_backend_pid()`.
5. Per statement:
   - SELECT-ish (`select`, `with`, `values`, `table`; comments stripped)
     → `DECLARE` a cursor and `FETCH` in batches (500 rows), enforcing
     `QUERY_MAX_ROWS` / `QUERY_MAX_BYTES` — overflow stops fetching and
     marks the result truncated. Events: `execution.columns`,
     `execution.rows` (sequenced per result set).
   - Other statements → direct execution; `execution.progress` carries
     `{ statement, command, affectedRows }` from Bun's result metadata.
6. Terminal event exactly once: `execution.completed` (row count,
   truncation, elapsed, statement count), `execution.failed` (code,
   message, cursor `position` when Postgres reports one), or
   `execution.cancelled`. The history row is updated to match.

### Cancellation (control path)

`Bun.SQL`'s `query.cancel()` is client-side only (verified against Bun
1.4: `pg_sleep` runs to completion). Cancellation therefore uses the
PostgreSQL administrative path: the registry calls
`pg_cancel_backend(pid)` from a **separate** pooled connection, which is
never blocked by the running statement. The running statement then fails
with "canceling statement due to user request"; because the registry
initiated the cancel, that error maps to `execution.cancelled`, not
`failed`. Cancellation is idempotent: cancelling a terminal execution
returns its terminal state. A statement timeout ("…statement timeout")
maps to `failed` with code `QUERY_TIMEOUT`.

### Registry and replay

The in-memory registry keeps each execution's events: lifecycle events
and the terminal event permanently (until TTL), the 50 most recent row
batches. `execution.subscribe` with `afterSequence` replays missed
events so a reconnecting client catches up; terminal state is always
deliverable. Executions are dropped 5 minutes after their terminal
event.

### Limits (all server-enforced)

| Limit | Mechanism |
| --- | --- |
| `QUERY_TIMEOUT_MS` | `statement_timeout` on the reserved connection |
| `QUERY_MAX_ROWS` | FETCH loop stops at the cap; `truncated: true` |
| `QUERY_MAX_BYTES` | serialized row bytes accumulate; same truncation |
| `MAX_CONCURRENT_QUERIES_PER_USER` | registry admission check |

`readOnly` connections additionally run with
`default_transaction_read_only = on`, so writes fail even if the target
role allows them.

### Bun.SQL constraints (accepted, verified by spike)

- No column-metadata API: column names come from the first fetched row's
  keys; data types are reported as `unknown` in the grid contract. An
  empty result set therefore shows no headers — acceptable until Bun
  exposes RowDescription.
- `affectedRows` is null on Postgres; affected counts come from the
  result's `command`/`count` properties instead.
- Multi-statement simple protocol is unused; statements are split and
  run individually so limits and cancellation apply per statement.

### Client

- `execution.start` from editor commands; per-document default
  connection (IndexedDB `documentPrefs`, phase-appropriate until server
  document sync lands).
- Executions store (Zustand): accumulates columns/rows per execution,
  tracks status; the singleton Results panel (Dockview, bottom) follows
  the active editor's latest execution: data grid (sticky header, first
  1,000 rows rendered), status line (status, elapsed, rows, truncation,
  affected rows), Cancel while running, inline errors with position.
- `history.list` returns paginated metadata (newest first); used by a
  simple History view in the results panel.

## Open questions

- Whether to keep one result tab per statement (DataGrip-style) once
  multi-result UX matters.
- `execution.subscribe` replay buffer bounds under very large results
  (currently 50 batches; memory-bounded by `QUERY_MAX_BYTES`).
- Arrow/binary result transport after profiling (initial_idea.md §19).
