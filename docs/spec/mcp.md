# Spec — MCP server

**Status:** current
**Phase:** 15
**Supersedes:** `docs/rfc/mcp.md` (promoted)

## Goal

Every project speaks MCP, so an agent working on the project's code can
ask the project's own database questions — and read the project's own
explanation of it.

The explanation is the point. Schemas, tables and column names are
already discoverable by introspection, and they are the least useful
half of the knowledge. Which datasource is which, how two of them
relate, which table is authoritative and which is a cache, what
`status = 4` means, what must never be run against the replica — that
lives in the workspace files and in the files under a datasource's path
pairs, and nowhere in any catalogue. MCP is how it reaches the model
instead of being re-guessed from field names every session.

Off by default, one endpoint per project, and read-only until somebody
says otherwise.

## Non-goals

- OAuth and the MCP authorization spec. A bearer token, minted in the
  app, revoked in the app.
- Streaming. Tool results are single JSON responses: no SSE, no
  resumable streams, no progress notifications. A query that outruns
  `QUERY_TIMEOUT_MS` fails the way it does in the editor.
- Structure editing, row editing and document writing over MCP. Write
  mode changes exactly one thing: whether a query commits.
- Agent-facing gripes. `check_sql` waits for the Phase 11 server-side
  runner.
- Prompts, sampling, roots, elicitation.
- An MCP *client*. DataGripe does not call other MCP servers, and none
  of this is AI query generation in the editor — still a non-goal.
- Cross-project tools. One project per endpoint, so no tool takes a
  project argument.

## Design

### One endpoint per project

`POST /mcp/<projectId>`, where `projectId` is the workspace id. Two
projects means two entries in the client's config, each with its own
token. A single endpoint with a `project` argument was the alternative,
and it fails the way every "which one did you mean" argument fails: the
agent picks, and eventually it picks the production one. The scope is in
the URL, the settings and the token are per-project rows, and there is
nothing to guess.

`GET` and `DELETE` on the route are `405` with `Allow: POST`. None of
this rides the WebSocket protocol: an MCP client is not a browser
session.

Stateless JSON-RPC 2.0 over HTTP (`apps/server/src/mcp/route.ts`).
Methods answered:

| Method | Notes |
| --- | --- |
| `initialize` | echoes the client's `protocolVersion` when it sends one, else `MCP_PROTOCOL_VERSION` |
| `notifications/initialized` | accepted, `202`, no body |
| `ping` | `{}` |
| `tools/list`, `tools/call` | the tool set below |
| `resources/list`, `resources/read` | the same reads, for clients where a human picks context |

Anything else is `-32601`. A JSON array body is refused: batching was
removed from the protocol, and one request per POST is the whole
transport. No `Mcp-Session-Id` is issued or required.

`initialize` returns `serverInfo { name: "datagripe/<project>", version }`,
`capabilities { tools: {}, resources: {} }`, and `instructions` — the
project's briefing (below), which is the highest-leverage string in the
feature because every client hands it to the model before the first tool
call.

### Authentication

Bearer token only. Cookies are **ignored** on this route: accepting the
session cookie would make a browser a usable MCP client and a CSRF
vector in the same stroke. An `Origin` header is fine when absent and
`403` when present and not `WEB_ORIGIN` — the MCP guidance on local
servers and DNS rebinding, applied without breaking non-browser clients.

`mcp_tokens` (migration 0019): `id`, `workspace_id`, `user_id`, `name`,
`token_hash`, `created_at`, `last_used_at`, `revoked_at`. The value is
`dgm_` plus 32 random bytes, base64url, SHA-256 at rest, shown once at
creation and never again — the same shape as `sessions`. There is no
expiry column: a token that dies mid-task is worse than one that lives
until somebody revokes it, so revocation is the control and
`last_used_at` is how you know whether to use it.

A token whose `workspace_id` does not match the URL gets `404`, not
`403`: a project id you cannot prove is a project we do not discuss.

The effective role is resolved on every call and never stored:

1. the minting user's **current** membership role — a token delegates
   one person's access, so demoting or removing them takes their agent's
   access with it, and that is the property that makes a token with no
   expiry acceptable;
2. capped at `editor`, never `owner`. Nothing reachable over MCP mints a
   token, changes the mode, adds a member, approves a repository command,
   exports domains or adds a datasource — and a context that cannot hold
   `owner` cannot grow a tool that does by accident.

Direct-in mode (`AUTH_DISABLED`) has no `workspace_members` rows at all,
so the stub workspace's owner counts as its owner. Everywhere else, a
missing membership row means the person was removed, and the token stops
working with a message that says so.

`run_query` is the only tool with a role rule of its own. In read-only
mode any member's token may run one: the statement is classified and
sandboxed, so it can do no more than the table view a viewer already
has. Committing is the app's `execution.start`, which is an editor
action — so read/write mode refuses a viewer's token, and says which of
the two things to change.

### Settings

`mcp_settings`: `workspace_id` primary key, `enabled` default false,
`mode` default `'read-only'`, `updated_by`, `updated_at`. No row means
off, which is why nothing bootstraps one.

Four actions, all `owner`: `mcp.settings` (the panel's whole state,
including the token list), `mcp.settings.set`, `mcp.token.create`,
`mcp.token.revoke`. This is an owner-level decision like repository
trust, and the panel is absent for everybody else rather than disabled
with a tooltip.

Turning MCP off revokes nothing and deletes no token; a valid token for
a disabled project gets `403` naming the toggle. Flipping read/write
back to read-only applies from the next call — in-flight commits are not
unwound, and the panel does not pretend otherwise.

### The deployment switch

`MCP_ENABLED`, default `true`. Not a mode-dependent default like
`AUTH_DISABLED`: the per-project toggle *is* the opt-in, and this is the
deployment's kill switch. Off means the route is absent (`404` through
the normal not-found path) and so is the sidebar section.

### Read-only

Three layers, in this order.

1. **Classification** (`apps/server/src/mcp/readonly.ts`). `sql-tools`
   splits the text and every statement must be a read: `select`, `with`,
   `values`, `table`, `explain`, `show` — and must contain no denied
   word at any nesting depth. It runs on tokens rather than text, so
   `-- delete everything` is a comment, `where note = 'drop table t'` is
   a string, and `select "update" from t` is a column.

   Depth matters: `WITH x AS (INSERT … RETURNING *) SELECT * FROM x`
   starts with an allowed word and writes, one paren deep. `into` is
   denied for `SELECT … INTO new_table`, and `update` doubles as the
   check on `SELECT … FOR UPDATE`.

   The deny list is deliberately tight. `replace` is a string function
   and `comment` is a plausible column name; a list long enough to catch
   them would refuse ordinary reads for nothing, and the leading-word
   check already covers `COMMENT ON`. The whole table is asserted in
   `readonly.test.ts`, both columns, because a change that quietly moves
   a statement from one to the other is the failure that matters.

2. **One read-only transaction per call, always rolled back.**
   `ExecuteLimits.sandbox` makes `beginExecution` open it and `close()`
   roll it back unconditionally: Postgres `BEGIN` + `SET TRANSACTION
   READ ONLY`, MySQL `START TRANSACTION READ ONLY`, SQLite `PRAGMA
   query_only = 1`.

   SQLite is a pragma rather than a transaction because its client is
   shared per file: a `BEGIN` there would be a transaction across
   everybody using that database, and a second overlapping session would
   fail on it. `close()` puts the pragma back.

   Postgres's cursor path already bracketed each statement in `BEGIN …
   ROLLBACK`, and inside a sandbox that would have ended the session's
   own transaction — leaving every later statement in autocommit, which
   is the one thing the sandbox exists to prevent. Inside a sandbox it
   uses `SAVEPOINT`/`RELEASE` instead, and rewinds to the savepoint when
   `DECLARE` fails so the fallback to direct execution can still report
   the real error rather than "current transaction is aborted".

3. **The datasource's own constraints.** A `readOnly` connection still
   gets `default_transaction_read_only = on`, and the target role's
   grants still apply.

What `ROLLBACK` does not undo, stated here so nobody sells layer 2 as a
sandbox: sequence and identity advancement, `setval`, non-transactional
DDL on MySQL, anything a function reaches through dblink, `postgres_fdw`
or `COPY TO PROGRAM`, and every side effect outside the database. Layer 1
is what stops writes. Layer 2 catches a classifier miss — proven, not
assumed, in `packages/database-adapters/src/postgres/sandbox.test.ts`,
which runs writes straight at the adapter with the classifier out of the
way and checks that nothing survived — and layer 3 catches both.

`statement_timeout` is set as it is for the editor, and the transaction
lives exactly as long as the one tool call: a held snapshot blocks
vacuum, and an agent that wandered off must not be able to pin one open.

Read/write mode has no wrapper and no classifier: the normal execution
path, with a history row, workspace-wide execution events and an audit
line. The only difference from a person pressing Ctrl+Enter is who
asked.

### The mode is a ceiling, never a grant

Read/write does not override a datasource's own `read only` setting, and
it cannot: layer 3 is the datasource's, not ours. A project whose
datasources are read-only stays read-only over MCP however the panel is
set — the mode decides whether *DataGripe* adds a restriction, and the
datasource decides what the connection can do in the first place.

So there is no per-datasource exposure switch, and no plan for one.
Which datasources a project contains, and which of them are read-only,
is already a project decision made on the datasource's own page; a
second place to answer it would mean two answers and eventually a
disagreement between them. Every datasource in the project is reachable,
every file already browsable in it is readable, and a datasource that
nobody should reach does not belong in the project.

The panel says this rather than leaving it to be discovered: with
read/write selected, the mode row names the datasources that are still
read-only by their own setting.

### Tools

Flat `snake_case` names, because the clients that prefix them with a
server name should still produce something readable. `tools/list` is
generated from the zod schemas (`z.toJSONSchema`), so the description an
agent reads and the validation it hits cannot drift apart.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `describe_project` | — | the orientation call: project name, mode, datasources (ref, name, engine, read-only, capabilities, description from `.datagripe/config.yaml`), each one's domain map, and the file index |
| `describe_domain` | `{ name, datasource? }` | one domain's description and object list, for projects too big to inline |
| `list_docs` | `{ datasource?, query? }` | the exposed files, filtered |
| `read_doc` | `{ uri, offset? }` | text, capped per call, with `truncated` and `nextOffset` |
| `search_docs` | `{ text, max? }` | uri, label, line number, line |
| `list_schemas` | `{ datasource? }` | over the existing `schema.children` introspection and its cache |
| `list_objects` | `{ datasource?, schema, kind? }` | tables, views, functions, procedures or sequences |
| `describe_object` | `{ datasource?, schema, name, kind? }` | the `object.describe` payload: columns, keys, indexes, constraints, triggers, grants, DDL |
| `run_query` | `{ datasource?, sql, maxRows? }` | `{ columns, rows, rowCount, resultSets, statements, truncated, elapsedMs, committed }` |

The domain map is in `describe_project` because the object-to-domain map
is the layout knowledge the catalogue does not hold: "which of these
forty tables are billing" is not answerable from `information_schema`,
and it is the first thing anybody needs. Hidden domains are excluded,
exactly as the export excludes them.

`datasource` accepts a ref or a name and defaults to the project's
default connection (or the only one, when there is only one); omitted
with no default is an error that lists the refs rather than saying "not
found". A datasource whose `unavailable` is set — an unset `passwordEnv`,
usually — is refused in its own words.

Files come back **verbatim**, never rendered: the model wants the
markdown source, and the `sql` fences in a runbook are the most useful
part of it. `read_doc` is capped at `MCP_READ_MAX_BYTES` per call, well
under the editor's `MAX_FILE_BYTES`, and says how to continue rather
than silently ending. `search_docs` is case-insensitive substring, not
regex — a tool an agent can get wrong in fifty ways reports "no matches"
when it means "bad pattern".

`run_query` caps rows at `MCP_MAX_ROWS` (200 by default; a larger
`maxRows` is clamped, not honoured) and bytes at `MCP_MAX_BYTES`. The
consumer is a context window, not a grid, so truncation says so and says
to aggregate or add `LIMIT`. Tool payloads serialize compact for the
same reason: pretty-printing a two-hundred-row result spends a third of
the window on whitespace.

**The file index.** Workspace documents, then every configured path
pair's tree, walked to six levels with a 400-entry cap per pair,
skipping `.git`, `node_modules`, `dist`, `build`, `target`, `vendor` and
friends, and listing only text extensions. A file-backed document is
listed once, as the file it came from: the artifact on disk is what a
teammate's checkout holds. A path pair that no longer resolves is
dropped from the index rather than failing it.

**Errors.** A malformed envelope, an unknown method or a bad project is a
JSON-RPC error. Everything a tool can be asked and fail at — no such
datasource, a refused write, a timeout, a missing file — is
`isError: true` with the message as text, so the model can correct
itself instead of the client reporting a transport failure. `ServiceError`
codes map straight onto that, carrying the message the app would show a
person.

### Resources

A mirror of the reads, for clients where a human assembles context by
hand: `datagripe://doc/<documentId>` and
`datagripe://file/<pathId>/<relative>`. `resources/list` is the file
index; `resources/read` is `read_doc` under the same cap. Tools are
primary — agents drive tools, and a client with no resource support loses
nothing.

### The briefing

`instructions` resolves in order:

1. `.datagripe/config.yaml` → `mcp: { instructions: <repo-relative
   file> }`, read through the same containment every other repo-declared
   path goes through (a committed symlink is not a read primitive);
2. a workspace file titled `AGENTS.md` or `CLAUDE.md`,
   case-insensitive;
3. nothing, and our words alone.

The repository wins because it travels with the clone: somebody who has
just cloned the project has not written a workspace file yet.

Our block comes **first** and is always ours: the project name, the mode
in plain words, the datasource list, and one line saying to call
`describe_project` first. Two reasons for the order — truncation eats
the tail, and the sentence about what this mode does must not be the
part that gets eaten; and a file somebody edited must not be able to
describe a read-only project as writable. The project's prose follows,
under a line naming where it came from, capped at
`MCP_INSTRUCTIONS_MAX_BYTES` with a pointer to `read_doc` for the rest.

### The panel

A `SidebarSections` entry, id `mcp`, **collapsed by default** and
rendered only for an owner and only when `MCP_ENABLED`.

Collapsed-by-default needed `defaultCollapsed?: boolean` on
`SidebarSection`. An id absent from `dg.sidebar.collapsed` renders
expanded, so the default has to be expressed rather than assumed — and
because the default now differs per section, an expand has to be
remembered as well as a collapse: `dg.sidebar.expanded` holds the ids of
default-collapsed sections a person has opened. Once they have touched
it, the stored list wins, like everywhere else.

Because the section only mounts when expanded, nothing reads the disk
while it is collapsed — which is what it is, by default.

Top to bottom:

- a `Toggle` for the server itself. Off reads "Nothing is listening for
  this project."
- read-only ⇄ read/write, the segmented shape the datasource page's
  overrides use. Read/write is a deliberate second press, its
  description states that every tool call commits, and when it is
  selected the row below names any datasource whose own `read only`
  still stands in the way.
- this project's endpoint URL with **copy url**, and **copy client
  config** producing the snippet a client wants
  (`{"mcpServers": {"datagripe-<project>": {"type": "http", "url": …,
  "headers": {"Authorization": "Bearer …"}}}}`). The token is inlined
  only while it is on screen at creation; afterwards the snippet carries
  a placeholder, because a value that was never stored cannot be shown
  twice.
- tokens: name, when it was last used, revoke. Creating one reveals the
  value once, in a row that says as much. Revoking asks first, because
  it stops an agent mid-task.
- one honest status line: `read only · 3 datasources · 12 files ·
  briefing from …`.

The panel's counts come from the same code the endpoint uses — the same
datasource list, the same file index, the same briefing resolution — so
what it shows is what an agent will actually get.

### Visibility inside the app

An MCP query is an execution. It gets its `query_executions` row, it
broadcasts the same events to the workspace, and the results panel and
history show it while it happens — the Phase 6d shape applied to a
non-human member. Migration 0019 adds `query_executions.source`
(`'editor'` by default) and `mcp_token_id`, and the history list carries
`source` and `via` so a row reads `dev@example.com · mcp · claude code
on the laptop` rather than leaving a teammate to wonder who the third
person in the project is.

The same change fixed a bug it would otherwise have inherited: the
history insert put `connection_id` in a `uuid` column for every
non-predefined source, so an execution against a git datasource
(`git:<uuid>`) failed on the history row before it ran. Only a managed
datasource goes in `connection_id` now; everything else is recorded as a
`connection_ref`, which is what the history view already falls back to
for a display name.

Audit lines: `mcp.settings.change`, `mcp.token.create`,
`mcp.token.revoke`, `mcp.tools.call` (tool, project, token, user — never
arguments, which contain data), `mcp.auth.failure`.

Rate limits, keyed per token rather than per user: `mcp.tools.call`
120/min and `mcp.query` 30/min — the same query ceiling a person has on
`execution.start`, so an agent in a loop cannot outrun the humans
sharing the datasource. `MAX_CONCURRENT_QUERIES_PER_USER` already
applies through the registry.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_ENABLED` | `true` | deployment kill switch; off means the route and the panel are absent |
| `MCP_PUBLIC_URL` | `http://localhost:$PORT` | what the panel tells people to point a client at |
| `MCP_MAX_ROWS` | `200` | ceiling for `run_query`, clamping `maxRows` |
| `MCP_MAX_BYTES` | `1000000` | serialized result cap per call |
| `MCP_READ_MAX_BYTES` | `65536` | `read_doc` / `resources/read` per call |
| `MCP_INSTRUCTIONS_MAX_BYTES` | `16384` | briefing cap |

Timeout and concurrency come from the existing `QUERY_*` limits.

### Where it lives

- `apps/server/src/mcp/`: `route.ts` (envelope, auth, method dispatch),
  `context.ts` (token → project, role, mode), `tools.ts` (definitions,
  schemas, handlers), `knowledge.ts` (datasources, domain map, file
  index, reads, search), `instructions.ts`, `service.ts` (the panel's
  half), `store.ts` (settings and tokens), `readonly.ts` (layer 1)
- `packages/contracts/src/mcp.ts`, plus `mcp` on `repoConfigSchema` and
  `source`/`via` on `historyEntrySchema`
- `ExecuteLimits.sandbox`, honoured by the three SQL adapters
- migration `0019_mcp.sql`
- `apps/web/src/components/McpSection.tsx`,
  `apps/web/src/stores/mcp.ts`, `defaultCollapsed` in
  `SidebarSections.tsx`

### A note on `bun --hot`

Not MCP's, but found while building it and fixed alongside: hot reload
re-evaluates the entry point in the same process, so every save opened
another connection pool and another pair of intervals while the previous
ones stayed alive — measured at +10 connections per save, which empties
a `max_connections = 100` cluster in six edits.

There is no hook for this: `import.meta.hot` is undefined under `bun
--hot` (Bun 1.4 — it exists for the frontend dev server, not for server
code), and `Bun.SQL`'s `idleTimeout` does not reap an abandoned pool's
sockets. `globalThis` does survive a reload, so `apps/server/src/hot.ts`
stashes a disposer per resource and the next evaluation runs them first.
The embedded cluster is handed forward instead of restarted.

## Open questions

- Whether a live MCP token appears in presence ("Online") as a
  non-human participant. It would answer "who is that" without opening
  history; it also puts a robot in a list of people.
- Whether `search_docs` should also reach object comments and DDL.
- `check_sql`, and gripe findings attached to `run_query` results, once
  the Phase 11 server-side runner lands.
- Whether read/write should also need a per-token opt-in, so one agent
  can write while another cannot.
- A `dry_run: true` argument in read/write mode — the useful half of
  rollback-as-read-only, with the honesty in the name.
- Redis. `run_query` and the introspection tools follow
  `ADAPTER_CAPABILITIES`, so a Redis datasource exposes neither and says
  why. Whether it gets a command tool at all is its own question.
