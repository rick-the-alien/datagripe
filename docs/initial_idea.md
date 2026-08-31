# DataGripe — Engineering Handoff

**Status:** Ready to scaffold  
**Product:** A web-based database IDE inspired by DataGrip  
**Initial database target:** PostgreSQL  
**Runtime:** Bun with native TypeScript execution  
**Last updated:** 2026-08-31

## 1. Product goal

Build a serious browser-based SQL workspace with an IDE-like editing experience:

- connect to PostgreSQL databases;
- browse schemas, tables, views, columns, indexes, and constraints;
- open many SQL documents without losing unsaved changes;
- drag tabs between editor groups and split the workspace horizontally or vertically;
- run a selection, statement, or whole document;
- view, paginate, copy, and export result sets;
- cancel running queries;
- restore the workspace after refresh or browser failure;
- establish an adapter boundary that can later support MySQL and SQLite, plus a separate Redis experience.

The first release should feel like a compact database IDE, not a generic admin dashboard.

## 2. Confirmed technical decisions

| Area | Choice | Reason |
| --- | --- | --- |
| Frontend | React + TypeScript + Vite | Mature ecosystem for Monaco and complex stateful UI |
| Docking/layout | `dockview-react` | IDE-style tab groups, drag/drop splitting, resizing, and layout serialization |
| Editor | Monaco Editor | Multiple persistent models, SQL editing, selections, diagnostics, and per-view state |
| Client state | Zustand | Explicit workspace/document state without coupling it to component lifecycles |
| Server state | TanStack Query | Connection metadata, schema data, executions, and invalidation |
| Crash recovery | IndexedDB via Dexie | Durable local drafts and workspace checkpoints |
| API runtime | Bun | Native TypeScript, HTTP/WebSocket server, test runner, package manager, and database clients |
| Application database | PostgreSQL through `Bun.SQL` | Durable users, workspaces, connection metadata, documents, and query history |
| API style | Authenticated multiplexed WebSocket + minimal HTTP | WebSocket for live workspace commands, responses, execution events, results, and cancellation; HTTP for auth/bootstrap, health, and downloads |
| Validation | Zod | Shared runtime validation at trust boundaries |
| Monorepo | Bun workspaces | Shared types and one toolchain without introducing a larger build orchestrator initially |

### Important terminology

There are two different kinds of database connection:

1. **Application database:** DataGripe's own PostgreSQL database, configured by `APP_DATABASE_URL`.
2. **Target database:** A database the user connects to and explores. Each saved connection produces target-database sessions.

Never use the application database client to execute editor SQL.

## 3. High-level architecture

```mermaid
flowchart TD
    UI["React workspace"] -->|bootstrap/auth/downloads| API["Bun HTTP"]
    UI <-->|commands, responses, events| WS["Authenticated WebSocket"]
    API --> APPDB["App PostgreSQL"]
    API --> VAULT["Credential encryption"]
    API --> CM["Connection manager"]
    WS --> RUN["Execution registry"]
    RUN --> CM
    CM --> TARGET["Target PostgreSQL"]
```

The browser never receives raw database credentials and never connects directly to a target database. All target queries pass through the server so authentication, authorization, cancellation, timeouts, auditing, and result limits are enforceable.

## 4. Repository layout

```text
datagripe/
├── apps/
│   ├── web/
│   │   ├── src/
│   │   │   ├── app/
│   │   │   ├── components/
│   │   │   ├── editor/
│   │   │   ├── explorer/
│   │   │   ├── results/
│   │   │   ├── stores/
│   │   │   ├── persistence/
│   │   │   └── api/
│   │   └── vite.config.ts
│   └── server/
│       ├── src/
│       │   ├── index.ts
│       │   ├── config.ts
│       │   ├── http/
│       │   ├── ws/
│       │   ├── auth/
│       │   ├── db/app/
│       │   ├── db/targets/
│       │   ├── execution/
│       │   ├── introspection/
│       │   └── crypto/
│       └── migrations/
├── packages/
│   ├── contracts/
│   ├── database-adapters/
│   ├── sql-tools/
│   └── test-support/
├── compose.yaml
├── package.json
├── bunfig.toml
├── tsconfig.base.json
└── .env.example
```

`packages/contracts` contains schemas and types shared by the browser and server. It must not contain server secrets, database clients, or Node/Bun-only imports.

## 5. Core frontend model

The layout, document, editor view, and query execution are separate domains.

```ts
type DocumentState = {
  id: string;
  workspaceId: string;
  title: string;
  language: "sql";
  savedContent: string;
  currentContent: string;
  revision: number;
  dirty: boolean;
  defaultConnectionId?: string;
  updatedAt: string;
};

type EditorViewState = {
  id: string;
  documentId: string;
  groupId: string;
  cursor: { line: number; column: number };
  selection?: {
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  };
  scrollTop: number;
};

type QueryExecutionState = {
  id: string;
  documentId: string;
  editorViewId: string;
  connectionId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  rowCount?: number;
  truncated?: boolean;
  error?: { code?: string; message: string; position?: number };
};
```

### Monaco lifecycle rules

- Create one Monaco model for each open document, keyed by a stable URI such as `datagripe://workspace/{workspaceId}/document/{documentId}.sql`.
- Keep a model alive while the document is open anywhere.
- Two editor views may point to the same model while maintaining separate selections and scroll positions.
- Switch models with `editor.setModel(model)`; do not refill an editor with `setValue()` on every tab switch.
- Dispose a model only when its document is closed from every view and its latest contents are checkpointed.
- The Zustand store is authoritative for domain state; Monaco is authoritative for active in-memory editing and undo history; IndexedDB is the crash-recovery layer.

### Persistence rules

- Debounce local draft checkpoints to IndexedDB, approximately 500–1,000 ms after edits.
- Persist Dockview's serialized layout whenever the layout stabilizes.
- Save documents to the server explicitly and on a conservative background cadence.
- On startup, compare the local draft revision/time with the server revision. Never silently overwrite a newer draft.
- Retain dirty drafts when a tab closes until the user explicitly discards them or a retention policy expires.

## 6. Bun server design

Use `Bun.serve` directly for the first server. Keep routing, validation, errors, and middleware-like concerns in small modules so a framework can be introduced later without changing domain services. After the browser bootstraps its session, one authenticated WebSocket becomes the primary application conduit.

```ts
import { serve } from "bun";

serve({
  port: Number(Bun.env.PORT ?? 3001),
  routes: {
    "/health": () => Response.json({ ok: true }),
  },
  fetch(req, server) {
    // authentication, remaining API routes, WebSocket upgrade, and 404
    return new Response("Not found", { status: 404 });
  },
  websocket: {
    message(ws, message) {
      // validate small client control messages only
    },
  },
});
```

### Application database client

Use one application-owned `SQL` pool and tagged templates for all controlled application queries.

```ts
import { SQL } from "bun";

export const appDb = new SQL(Bun.env.APP_DATABASE_URL!, {
  max: 10,
  idleTimeout: 30,
  connectionTimeout: 10,
});

const workspaces = await appDb`
  SELECT id, name
  FROM workspaces
  WHERE owner_id = ${userId}
`;
```

Do not interpolate identifiers or SQL fragments with JavaScript string concatenation. Use the SQL helper for controlled dynamic identifiers.

### Target connection manager

Implement a `DatabaseAdapter` boundary from day one even though PostgreSQL is the only initial adapter.

```ts
export interface DatabaseAdapter {
  testConnection(secret: DecryptedConnection): Promise<ConnectionTestResult>;
  introspect(session: TargetSession, request: IntrospectionRequest): Promise<SchemaNode[]>;
  execute(session: TargetSession, request: ExecuteRequest): Promise<ExecutionHandle>;
  cancel(executionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
}
```

Each adapter is responsible for dialect-specific introspection, execution, cancellation, type normalization, and errors. Do not pretend PostgreSQL, MySQL, SQLite, and Redis have identical capabilities.

`Bun.SQL` gives the SQL adapters a common lower-level client for PostgreSQL, MySQL, and SQLite. Redis must use Bun's separate `RedisClient` and should eventually have its own command/document experience rather than being forced into the SQL abstraction.

## 7. Executing editor SQL safely

Free-form SQL from an editor is, by definition, a runtime string. The server will need the target client's raw execution method. That method is not an injection vulnerability by itself—the user is intentionally authoring SQL—but it creates a privileged boundary that requires strict controls.

### Required controls

- authorize the workspace and connection on every execution;
- decrypt credentials only in server memory, immediately before use;
- enforce TLS policy for remote targets;
- default new connections to read-only mode where practical;
- use a dedicated database role with the least required privileges;
- set a server-enforced statement timeout;
- cap returned rows and serialized bytes;
- stream or batch large results instead of buffering indefinitely;
- register every running execution so it can be cancelled;
- record actor, connection, timing, outcome, and a redacted/fingerprinted query;
- never log credentials or complete result values by default;
- reject connection hosts blocked by the SSRF policy;
- apply per-user and per-connection concurrency limits;
- close abandoned sessions and executions after heartbeat expiry.

### SSRF policy

A hosted database client can become a network pivot. Before opening any target connection:

- resolve hostnames server-side;
- block loopback, link-local, multicast, metadata-service, and private network ranges by default;
- prevent DNS rebinding by validating resolved addresses at connection time;
- allow private targets only through an explicit deployment-level allowlist or a future customer agent/tunnel;
- validate ports and supported protocols;
- do not accept arbitrary TLS certificate bypass in production.

For a self-hosted edition, private-network access can be configurable because the deployer controls the network boundary.

### Query execution lifecycle

```mermaid
stateDiagram-v2
    [*] --> Queued
    Queued --> Running
    Queued --> Cancelled
    Running --> Succeeded
    Running --> Failed
    Running --> Cancelled
    Succeeded --> [*]
    Failed --> [*]
    Cancelled --> [*]
```

The execution registry maps `executionId` to the owning user, target session, active query handle, status, and subscribers. Cancellation must be idempotent: cancelling an already completed execution returns its terminal state rather than failing unpredictably.

## 8. Initial application data model

Use UUIDs, `timestamptz`, and explicit foreign keys. Store connection secrets separately from display metadata.

| Table | Purpose | Important fields |
| --- | --- | --- |
| `users` | Product identity | `id`, `email`, `created_at` |
| `workspaces` | Top-level user workspace | `id`, `owner_id`, `name`, `created_at` |
| `workspace_members` | Future collaboration/RBAC | `workspace_id`, `user_id`, `role` |
| `connections` | Safe connection metadata | `id`, `workspace_id`, `name`, `adapter`, `host`, `port`, `database_name`, `username`, `tls_mode`, `read_only` |
| `connection_secrets` | Encrypted secrets | `connection_id`, `ciphertext`, `key_version`, `updated_at` |
| `documents` | Saved SQL files | `id`, `workspace_id`, `title`, `content`, `revision`, `default_connection_id`, `updated_at` |
| `workspace_layouts` | Serialized Dockview state | `workspace_id`, `layout_json`, `revision`, `updated_at` |
| `query_executions` | History and audit metadata | `id`, `user_id`, `connection_id`, `document_id`, `status`, `query_hash`, `preview`, `started_at`, `finished_at`, `row_count`, `truncated`, `error_code` |

Do not store full result sets in the application database in the first release. Send them to the connected client and discard them after a short server-side TTL. Exports should stream to the requester; future durable exports can use object storage.

### Concurrency strategy

- `documents.revision` increments on every server save.
- Updates use `WHERE id = ? AND revision = ?` semantics.
- A revision mismatch returns `409 Conflict` with current metadata, leaving merge/recovery to the client.
- Use the same revision guard for workspace layouts.

## 9. Transport split

Use HTTP where browser and infrastructure semantics make it the better fit, and the authenticated WebSocket for the stateful workspace session.

| Transport | Responsibilities |
| --- | --- |
| HTTP | login/callback/logout, session bootstrap, health/readiness, large file upload, streamed export download |
| WebSocket | document/layout commands, connection tests, introspection, query execution, result batches, progress, cancellation, presence/notifications later |

All messages and HTTP bodies are validated with shared Zod schemas. Errors use one shape:

```ts
type ApiError = {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
};
```

### Minimal HTTP routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness only; no dependency details |
| `GET` | `/api/session` | Bootstrap current user, CSRF/session metadata, and WebSocket URL |
| `POST` | `/api/auth/logout` | End the session and revoke active sockets |
| `GET` | `/api/exports/:id` | Authorized streaming download for a prepared export |

Authentication-provider callback routes are added as required by the selected provider.

## 10. WebSocket protocol

Use a small, versioned, bidirectional protocol. Every client request gets a `requestId`; immediate acceptance/rejection is returned as a response, while long-running work continues through correlated events.

```ts
type ClientRequest<T = unknown> = {
  version: 1;
  kind: "request";
  requestId: string;
  action: string;
  payload: T;
};

type ServerMessage<T = unknown> =
  | {
      version: 1;
      kind: "response";
      requestId: string;
      ok: boolean;
      payload?: T;
      error?: ApiError["error"];
    }
  | {
      version: 1;
      kind: "event";
      eventId: string;
      topic: string;
      executionId?: string;
      sequence?: number;
      occurredAt: string;
      payload: T;
    };
```

Initial client actions include:

| Action | Result |
| --- | --- |
| `workspace.open` | Workspace, layout revision, document list, and safe connection metadata |
| `layout.save` | Revision-guarded layout acknowledgement or conflict |
| `document.get/create/save/archive` | Document CRUD with revision guards |
| `connection.create/update/test/delete` | Encrypted connection management |
| `schema.children` | Lazy introspection for one tree node |
| `execution.start` | Immediate acceptance with `executionId`; lifecycle continues as events |
| `execution.cancel` | Immediate cancellation acknowledgement and eventual terminal event |
| `execution.subscribe` | Subscribe or resume from a known event sequence |
| `history.list` | Paginated query history |

Execution event topics include `execution.started`, `execution.columns`, `execution.rows`, `execution.progress`, `execution.completed`, `execution.failed`, and `execution.cancelled`.

### Authentication and authorization requirements

- authenticate the WebSocket upgrade with the existing `HttpOnly` browser session cookie; browser WebSocket APIs cannot reliably attach arbitrary authorization headers;
- require an allowed `Origin` during upgrade to prevent cross-site WebSocket hijacking;
- issue a short-lived, single-use socket ticket from `/api/session` if deployment topology makes cookie-only upgrade validation awkward;
- bind each accepted socket to `userId`, `sessionId`, and an authorization snapshot;
- re-authorize the referenced workspace, document, connection, or execution on every action—socket authentication is not object authorization;
- close sockets when the session expires, is revoked, or the user logs out;
- never put bearer tokens, credentials, or connection strings in the WebSocket URL;
- rate-limit by user/session/action and cap both decoded message size and outstanding requests;
- validate every discriminated message before dispatch and return generic errors for malformed or unauthorized actions;
- keep WebSocket compression disabled for secret-bearing messages unless its side-channel implications have been reviewed.

### Reliability and flow-control requirements

- use one multiplexed socket per browser workspace/session, not one socket per query;
- keep execution state on the server; the socket is a subscriber, not the owner of the query;
- number row batches and let clients resume from the last acknowledged sequence;
- cap event size;
- bound each connection's outbound queue and apply backpressure; pause result production when possible, otherwise cancel before memory grows without limit;
- heartbeat connections and release server resources after disconnect;
- make terminal events and a bounded number of recent batches replayable for a short TTL;
- use idempotency keys for mutating actions so reconnect/retry cannot duplicate document creation or query execution;
- if the socket drops, allow active queries to continue only for a short grace period, then cancel unless the client reconnects or explicitly requested detached execution.

### Cancellation control path

Cancellation is a high-priority control message, not ordinary work queued behind result traffic. `execution.cancel` must:

1. authenticate and authorize the execution owner;
2. look up the live execution handle in the server registry;
3. invoke `Bun.SQL` query cancellation or the adapter's dialect-specific cancellation mechanism on a control path that is not blocked by the running query;
4. acknowledge that cancellation was requested;
5. emit exactly one eventual terminal event: `execution.cancelled`, `execution.completed`, or `execution.failed` if the query won the race.

Transport-level nonblocking behavior alone is insufficient. The target adapter must retain a cancellable handle or use a separate administrative connection where the database protocol requires it.

## 11. Schema explorer and introspection

Load the tree lazily:

```text
connection
└── database
    └── schema
        ├── tables
        │   └── table
        │       ├── columns
        │       ├── indexes
        │       └── constraints
        ├── views
        ├── functions
        └── types
```

Cache introspection responses briefly by `connectionId + database + schema + node type`. Invalidate manually through Refresh and automatically after successful DDL when the affected object can be inferred. Correctness wins over elaborate SQL parsing in the MVP, so a post-DDL refresh prompt is acceptable.

## 12. Authentication and secrets

Authentication provider choice is intentionally left open, but the server contract assumes cookie-based sessions:

- `HttpOnly`, `Secure`, and appropriate `SameSite` cookies;
- CSRF protection on state-changing HTTP routes;
- origin validation for HTTP and WebSocket requests;
- workspace-scoped authorization on every resource;
- rate limiting on login, connection test, introspection, and execution routes.

Connection passwords are encrypted at rest with an authenticated encryption scheme. Keep a versioned key identifier beside the ciphertext so keys can rotate. The master key belongs in the deployment secret manager, never PostgreSQL, source control, logs, or the browser.

## 13. Local development setup

### Prerequisites

- Bun (pin the accepted runtime in `package.json` and CI)
- Docker or another local PostgreSQL installation
- Git

### Root scripts

```json
{
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "bun run --filter '*' dev",
    "dev:web": "bun --cwd apps/web run dev",
    "dev:server": "bun --cwd apps/server run dev",
    "test": "bun test",
    "typecheck": "bun run --filter '*' typecheck",
    "lint": "bun run --filter '*' lint",
    "db:migrate": "bun --cwd apps/server run db:migrate"
  }
}
```

The exact concurrent-development command should be verified during scaffolding; if workspace filtering does not provide clean long-running process output, add a small process runner rather than hiding orchestration in shell syntax.

### Environment contract

```dotenv
NODE_ENV=development
PORT=3001
WEB_ORIGIN=http://localhost:5173
APP_DATABASE_URL=postgres://datagripe:datagripe@localhost:5432/datagripe
CONNECTION_ENCRYPTION_KEY=replace-with-a-generated-development-key
SESSION_SECRET=replace-with-a-generated-development-secret
QUERY_TIMEOUT_MS=30000
QUERY_MAX_ROWS=10000
QUERY_MAX_BYTES=25000000
MAX_CONCURRENT_QUERIES_PER_USER=3
```

Commit `.env.example`, never `.env`.

### First-run sequence

```bash
bun install
docker compose up -d postgres
bun run db:migrate
bun run dev
```

## 14. Testing strategy

### Unit tests

- SQL selection/statement range detection;
- document revision conflicts;
- adapter type normalization;
- error normalization and redaction;
- hostname/IP blocking rules;
- encryption round trips and key version handling;
- execution lifecycle transitions.

### Integration tests

- application migrations against a disposable PostgreSQL instance;
- target connection test and lazy introspection;
- execution, result limits, statement timeout, and cancellation;
- disconnect cleanup;
- authorization isolation between two workspaces;
- encrypted secrets are never returned from APIs.

### Browser tests

- edit a document, switch tabs, and return without losing content;
- show the same document in two editor groups with independent view state;
- drag tabs to split and serialize/restore the layout;
- reload after an unsaved edit and recover the IndexedDB draft;
- run selected SQL and receive results;
- cancel a long query;
- handle a `409` document conflict without data loss.

Use Bun's test runner for server/package tests and Playwright for end-to-end browser behavior.

## 15. Delivery phases

### Phase 0 — Foundation

- scaffold Bun workspaces, React/Vite app, Bun server, shared contracts, and PostgreSQL compose service;
- add config validation, structured logging, request IDs, migrations, CI, and health checks;
- establish authentication stub/session boundary.

**Exit:** one command starts web, server, and app database; CI runs type checking and tests.

### Phase 1 — IDE shell

- Dockview workspace with movable tabs and horizontal/vertical splits;
- Monaco document registry with one model per document;
- Zustand document/view stores;
- IndexedDB draft and layout recovery.

**Exit:** multiple documents survive tab switching, splitting, and browser reload without lost changes.

### Phase 2 — PostgreSQL connections and explorer

- encrypted connection storage;
- connection test;
- PostgreSQL adapter and lazy schema explorer;
- refresh/caching behavior.

**Exit:** a user can save a connection and browse schemas/tables/columns without seeing stored credentials.

### Phase 3 — Query execution

- selection/statement/document execution;
- execution registry and WebSocket events;
- data grid, errors, elapsed time, row/byte caps, timeout, and cancellation;
- query history metadata.

**Exit:** queries run, stream bounded results, cancel reliably, and produce an auditable terminal state.

### Phase 4 — Product hardening

- authentication provider and RBAC;
- SSRF controls and deployment allowlists;
- rate and concurrency limits;
- observability, backup/restore practice, and load tests;
- CSV/JSON export and keyboard-accessibility pass.

**Exit:** production-readiness review passes for the intended deployment model.

### Phase 5 — Additional adapters

- MySQL adapter using `Bun.SQL`;
- SQLite adapter where server-side file access fits the deployment model;
- Redis connection and command browser using `RedisClient` as a distinct capability.

**Exit:** adapters expose honest capability flags and do not leak dialect-specific behavior into generic UI state.

## 16. MVP acceptance criteria

The first usable MVP is complete when:

- a user can create, edit, rename, save, close, and restore SQL documents;
- at least two tab groups can display different documents or two views of one document;
- unsaved contents survive tab switches and an accidental page reload;
- a PostgreSQL connection can be saved with encrypted credentials and tested;
- the explorer lazily shows schemas, tables, and columns;
- a selection or full document can execute;
- the UI shows columns, rows, duration, affected-row count, truncation, and errors;
- a long-running query can be cancelled;
- row, byte, timeout, and concurrency limits are enforced server-side;
- one workspace cannot access another workspace's documents, connections, executions, or events;
- logs and API responses do not leak credentials.

## 17. Explicit non-goals for the first MVP

- full DataGrip feature parity;
- visual schema design or migration generation;
- database administration workflows such as role management and backups;
- SSH tunnels, cloud-provider IAM authentication, or customer network agents;
- collaborative live editing;
- AI query generation;
- offline target-database execution;
- durable storage of full query result sets;
- production Redis/MySQL/SQLite editing before PostgreSQL is solid.

## 18. First engineering tickets

1. Scaffold the Bun workspace and React/Vite application.
2. Add PostgreSQL compose service, config validation, and migration runner.
3. Define shared Zod API contracts and standardized errors.
4. Implement application DB access through one `Bun.SQL` pool.
5. Add Dockview with layout serialize/restore.
6. Build the Monaco model registry and split-safe `EditorView` component.
7. Implement Zustand stores and IndexedDB recovery.
8. Add encrypted connection CRUD and PostgreSQL connection test.
9. Implement the PostgreSQL adapter's schema/table/column introspection.
10. Implement execution registry, raw target query execution, limits, and cancellation.
11. Add authenticated WebSocket execution events and result batches.
12. Build result grid, history panel, and end-to-end tests.

## 19. Decisions to make before production

- hosted, self-hosted, or both;
- authentication provider and organization model;
- whether private-network targets require an agent/tunnel;
- deployment secret manager and encryption key rotation procedure;
- exact query result transport: JSON row batches first, with Arrow considered only after profiling;
- SQL parser choice for statement-at-cursor behavior;
- schema cache TTL and invalidation policy;
- retention period for drafts, history, audit data, and exports;
- open-source license and whether the DataGripe name will be retained.

## 20. Reference documentation

- [Bun SQL documentation](https://bun.sh/docs/runtime/sql) — native PostgreSQL, MySQL, and SQLite clients, pooling, transactions, raw queries, and cancellation.
- [Bun Redis documentation](https://bun.sh/docs/runtime/redis) — native Redis client.
- [Bun HTTP server documentation](https://bun.sh/docs/runtime/http/server) — `Bun.serve` server API.
- [Bun WebSocket documentation](https://bun.sh/docs/runtime/http/websockets) — server-side WebSocket API.
- [Dockview documentation](https://dockview.dev/docs/core/overview/) — IDE-like dockable panels and groups.
- [Monaco Editor repository](https://github.com/microsoft/monaco-editor) — editor models and browser integration.

---

### Recommended starting stance

Keep the initial system deliberately small: one Bun API process, one React application, one application PostgreSQL database, and PostgreSQL-only target connections. Preserve clean adapter and execution boundaries now, but delay multi-database behavior until tab state, draft recovery, query cancellation, and security controls are dependable. Those foundations determine whether DataGripe feels like a trustworthy IDE.
