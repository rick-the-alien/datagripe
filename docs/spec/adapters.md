# Spec — Database adapters

**Status:** current
**Phase:** 5
**Supersedes:** nothing (extends `docs/initial_idea.md` §6;
`docs/spec/query-execution.md` for execution mechanics)

## Goal

MySQL, SQLite, and Redis sit beside PostgreSQL behind the adapter
boundary. Adapters report honest capability flags; the UI and dispatcher
gate on those flags and never branch on adapter ids.

## Non-goals

- Redis command execution (the browser is read-only: SCAN + value fetch).
- MySQL server-side cursor streaming (does not exist for arbitrary
  SELECTs; buffered fetch with caps instead).
- SQLite cancellation (no driver-level interrupt; local files make
  runaway queries cheap to bound by caps).
- MySQL TLS `verify-full` with custom CAs (same limitation as postgres).

## Capability model

`ADAPTER_CAPABILITIES` (`packages/contracts/src/adapters.ts`) is the
single source of truth, shared by server and client:

| | postgres | mysql | sqlite | redis |
| --- | --- | --- | --- | --- |
| introspection | sql | sql | sql | keyspace |
| execution | cursor | buffered | buffered | – |
| cancellation | ✓ | ✓ | – | – |
| default port | 5432 | 3306 | – | 6379 |
| dialog fields | full | full | file path, read-only | host, port, db index, password, tls, read-only |

- `introspection: "sql"` → schema/tables/views/columns tree.
- `introspection: "keyspace"` → db → prefix → key tree over the `:`
  delimiter; leaf clicks fetch values via `redis.get`.
- `execution: "cursor"` → server-side cursor with FETCH batching.
- `execution: "buffered"` → full result fetch, truncated to
  `QUERY_MAX_ROWS` / `QUERY_MAX_BYTES`.
- `execution: null` → `execution.start` is rejected server-side and the
  Run buttons disable client-side. `cancellation: false` hides Cancel.

## Per-adapter behavior

### MySQL

- Introspection via `information_schema` (system schemas excluded).
- Execution: buffered. Timeout is enforced primarily by
  `SET SESSION max_execution_time`; a client-side watchdog (KILL at
  timeout + elapsed check) is the deterministic backstop.
- Cancellation: `KILL QUERY <connection_id>` from a second connection —
  the same administrative-control-path shape as postgres.
- **Driver quirk (verified):** Bun's MySQL driver resolves interrupted
  statements *cleanly* (`SLEEP` returns 1, no error, empty
  `SHOW WARNINGS`). Outcomes are therefore tracked out-of-band:
  `cancelIssued` flag for kills, watchdog for timeouts.
- `allowPublicKeyRetrieval: true` only when `tlsMode = "disable"`
  (caching_sha2_password over plain TCP — acceptable on trusted local
  links; TLS modes never set it).

### SQLite

- `database` carries the **server-side file path**; host/port/username/
  TLS are null in metadata.
- Schemas = `PRAGMA database_list` (main + attached); objects via
  `sqlite_master`; columns via `PRAGMA table_info`.
- **Driver quirk:** Bun's SQLite adapter does not support `reserve()` —
  the per-file client is the dedicated connection; sessions wrap it
  directly.
- `readOnly` opens the file read-only at the driver level.

### Redis

- A distinct capability, not SQL: PING test, SCAN-bounded keyspace tree
  (10k keys/level, truncation marker node), `redis.get` for values
  (string/hash/list/set/zset, TTL, 100-entry cap).
- **Driver quirk:** `HGETALL` returns an object in Bun's client, not a
  flat array.
- No execution; `readOnly` is informational (browser is read-only
  anyway).

## Contract notes

- `connectionMetadataSchema` host/port/username/tlsMode are nullable
  (SQLite). `databaseName` means database name, file path, or DB index
  per adapter (`databaseLabel` in capabilities).
- `schemaNodeKindSchema` gains `db`, `prefix`, `key` — generic tree
  kinds, not dialect branches.
- `workspace.open` includes `adapters: AdapterInfo[]` mirroring
  `ADAPTER_CAPABILITIES` so clients could consume server-driven
  capabilities later.

## Open questions

- Whether Redis earns command execution later (would be a separate
  capability flag, not SQL).
- Attached-database management UI for SQLite.
- Whether MySQL should stream via unbuffered driver internals if Bun
  ever exposes them.
