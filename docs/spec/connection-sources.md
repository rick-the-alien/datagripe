# Spec — Connection sources

**Status:** draft
**Phase:** 2
**Supersedes:** nothing (extends `docs/initial_idea.md` §6, §8)

## Goal

Connections are managed like DataGrip data sources: first-class, named,
testable objects the user adds and organizes — not a deployment detail.
In addition to user-created connections stored in the application database,
operators can predefine connections via configuration (environment variables
or a config file) so a deployment can ship with ready-made data sources.

## Non-goals

- Editing predefined connections in the UI (they are read-only in the UI;
  change the config and restart/reload).
- Per-user overrides of predefined connections (v1: predefined connections
  are visible to every member of the workspaces listed in their definition).
- Hot reload of the config file (restart required; hot reload is an open
  question below).

## Definitions

| Term | Meaning |
| --- | --- |
| Managed connection | Created in the UI, stored in `connections` + `connection_secrets` |
| Predefined connection | Declared in server configuration; materialized read-only |

Both kinds implement the same `ConnectionMetadata` contract
(`packages/contracts/src/connections.ts`) so the explorer, editor, and
execution paths never branch on origin.

## Design

### Configuration format

Predefined connections come from one JSON file, path given by
`CONNECTIONS_FILE` (default: `connections.json` at the repo root, ignored by
git). Environment variables may supply secrets by reference so the file
itself stays commit-safe:

```json
{
  "connections": [
    {
      "id": "local-dev",
      "name": "Local Dev Postgres",
      "adapter": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "datagripe",
      "username": "datagripe",
      "passwordEnv": "DEV_PG_PASSWORD",
      "tlsMode": "disable",
      "readOnly": true,
      "workspaces": ["*"]
    }
  ]
}
```

- `id` is stable, kebab-case, unique within the file.
- Secrets are declared as `passwordEnv: "VAR_NAME"` (indirection into the
  process environment). Inline `password` is accepted but documented as
  development-only.
- `workspaces` lists workspace names or `"*"` for all workspaces.
- The file is validated at startup with a Zod schema in
  `packages/contracts` (`predefinedConnectionsFileSchema`); invalid files
  fail boot with per-entry error messages.

### Server behavior

1. At boot, `apps/server/src/config.ts` loads and validates the file.
2. Predefined connections are exposed through the same `workspace.open`
   payload and `connection.test` action as managed ones. The response marks
   them `source: "predefined"` (managed connections report
   `source: "managed"`); `ConnectionMetadata` gains this field.
3. Secrets for predefined connections never touch the application database:
   the server resolves `passwordEnv` into memory at boot, decrypt-where-used
   semantics do not apply, and the value is held only in the connection
   manager.
4. `connection.create/update/delete` targeting a predefined id returns
   `FORBIDDEN` with code `CONNECTION_READ_ONLY`.
5. Authorization: a predefined connection is usable only in the workspaces
   its definition names.

### Schema impact

`connections` rows remain managed-only. Predefined connections are **not**
inserted into `connections`; `query_executions.connection_id` gains a
companion `connection_ref text` (e.g. `predefined:local-dev`) so history and
audit survive without a foreign key. The `documents.default_connection_id`
column cannot reference predefined ids; documents opened against a
predefined connection store that preference client-side (IndexedDB) until a
nullable `default_connection_ref` column is added in a later migration —
tracked as an open question.

### Conflict rules

- A predefined `id` colliding with another predefined `id` fails boot.
- Predefined and managed connections live in disjoint id namespaces
  (predefined ids are slugs, managed ids are UUIDs), so no runtime collision
  is possible.

## Client behavior

- The explorer renders one list, with a subtle badge on predefined entries.
- The connection dialog's save button is disabled for predefined entries;
  the form renders read-only with a "Defined by server configuration" hint.
- Test-connection works identically for both kinds.

## Open questions

- Hot reload of `CONNECTIONS_FILE` (SIGHUP or file watch) vs restart-only.
- Whether documents should be able to persist `default_connection_ref`
  server-side (schema change) instead of client-side.
- Per-workspace visibility scoping UX once real auth exists (`workspaces`
  currently matches by name; switch to ids when seeded workspaces exist).
