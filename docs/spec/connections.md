# Spec — Connections and schema explorer

**Status:** current
**Phase:** 2
**Supersedes:** nothing (implements `docs/initial_idea.md` §6, §8, §11, §12;
extends with `docs/spec/connection-sources.md`)

## Goal

A user can save a PostgreSQL connection with an encrypted password, test
it, and lazily browse schemas, tables, views, and columns — without the
password ever leaving server memory or appearing in any client payload.

## Non-goals

- Query execution against targets (Phase 3).
- Authentication, per-user authorization, SSRF controls (Phase 4).
- Connection organization beyond a flat list (folders/groups later).
- Documents' default connection binding (Phase 3 with execution).

## Definitions

| Term | Meaning |
| --- | --- |
| Managed connection | Created in the dialog, stored in `connections` + `connection_secrets` |
| Predefined connection | Declared in `CONNECTIONS_FILE`; see `connection-sources.md` |
| Resolved connection | Connection metadata plus decrypted password, held in server memory only (`ResolvedConnection` in `packages/database-adapters`) |

## Design

### Secret storage

- Passwords are encrypted with AES-256-GCM by `apps/server/src/crypto/keyring.ts`.
- The key ring derives a 32-byte key per version from deployment material
  (`CONNECTION_ENCRYPTION_KEY` = version 1) via domain-separated SHA-256.
- Ciphertext layout: `iv (12) ‖ ciphertext ‖ tag (16)`, stored as bytea in
  `connection_secrets` beside `key_version`. Rotation adds a new version;
  every ring version decrypts, only the highest encrypts.
- `ConnectionMetadata` (contracts) never contains a password; the dialog's
  password field is write-only (empty while editing keeps the stored
  secret, and `connection.test` by id exercises the stored secret).

### Actions (WebSocket)

| Action | Behavior |
| --- | --- |
| `workspace.open` | Returns the workspace descriptor and all visible connections (predefined + managed), sorted by name |
| `connection.create` | Validates, inserts metadata + encrypted secret in one transaction; idempotent via `idempotency_keys` (migration 0002) |
| `connection.update` | Partial merge; `password` present → re-encrypt; targeting a predefined id → `CONNECTION_READ_ONLY` |
| `connection.delete` | Cascades to the secret row; predefined → `CONNECTION_READ_ONLY` |
| `connection.test` | By `connectionId` (managed: decrypt; predefined: in-memory) or by inline `draft` (unsaved dialog fields, never persisted) |
| `schema.children` | Lazy introspection; see below |

Idempotent mutations store their response in `idempotency_keys` keyed by
`(workspace_id, action, key)`; retries replay the stored response.

### Pre-authentication stub

There is no auth yet (Phase 4). At boot the server ensures a stub user
(`local@datagripe.local`) and a `Local` workspace (`bootstrap.ts`); all
rows are workspace-scoped to it. Every query already carries
`workspace_id` so the Phase 4 session swap changes resolution, not the
data model.

### Introspection

The adapter (`packages/database-adapters`, `PostgresAdapter`) walks one
tree level per call:

```text
[]                       → schemas (system schemas excluded)
[schema]                 → categories: tables, views
[schema, tables]         → base tables
[schema, views]          → views
[schema, tables, table]  → columns (name, data_type, nullable)
[schema, views, view]    → columns
```

- Target clients pool per connection fingerprint (host, port, database,
  username, TLS mode, password fingerprint) so a password change never
  reuses a stale pooled client.
- The connections service caches children per `(connectionId, path)` for
  30 s. `schema.children` with `refresh: true` bypasses and rewrites the
  cache; the explorer's refresh button refetches exactly its expanded
  paths plus the connection root with `refresh: true` and drops cached
  children of collapsed nodes.
- DDL invalidation is deferred: Phase 3 refreshes affected nodes after
  successful DDL instead of parsing SQL now (initial_idea.md §11).

### Client

- One multiplexed `WsClient` (`apps/web/src/api/ws.ts`): request/response
  correlation, send queue until open, pending requests rejected on close,
  1 s reconnect; every reopen reloads `workspace.open` and resets the
  explorer.
- The explorer tree is a Zustand store, not TanStack Query: refresh must
  propagate `refresh: true` into the request payload for exactly the
  expanded paths, which query caches cannot express. Children cache per
  node key (`connectionId/kind:name/…`) until refresh or reconnect.
- The connection dialog (DataGrip-style): name, host, port, database,
  username, password (write-only), TLS mode, read-only flag, Test, Save.
  Predefined connections render read-only with a "Defined by server
  configuration" hint; Test works identically for both kinds.

## Open questions

- Retention/cleanup of `idempotency_keys` rows (currently unbounded).
- Whether introspection cache TTL should be configurable per deployment.
- TLS `verify-full` currently maps to `rejectUnauthorized: true` without
  custom CA support; deployment CA configuration arrives with Phase 4
  hardening.
