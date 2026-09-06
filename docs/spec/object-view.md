# Spec — Object view

**Status:** current
**Phase:** 9
**Supersedes:** nothing (implements `docs/brand/brand-system.md`
"Object view — the structure" and "Danger zone"; the tab strip follows
`docs/brand/mocks/tree-interactions.html`)

## Goal

The `⊞` affordance, or any structure entry in the tree's context menu,
opens one object's structure as an editor tab. What that means depends
on the object:

| Kind | Tabs | Double click opens |
| --- | --- | --- |
| table | columns · indexes · constraints · triggers · grants · statistics · ddl · **danger zone** | the table view (rows) |
| view | the same, minus editing | the table view (rows) |
| function, procedure | arguments · grants · statistics · ddl | **the ddl tab** |
| sequence | statistics · ddl | **the ddl tab** |

A routine has no rows to browse — its definition *is* the object — so
double-clicking one lands on the ddl tab rather than opening a grid. The
columns tab of a base table is editable
(see [Editing columns](#editing-columns)).

## Non-goals

- **A data tab.** Rows are the table view's job
  (`docs/spec/table-view.md`). That separation is what lets both
  surfaces be generous with space, and it is the reason the object view
  can grow tabs without a redesign.
- Editing a routine's or view's body. The ddl tab shows a definition; it
  does not save one back.
- Index, constraint and trigger changes. Only columns are editable.
- **Executing the danger zone.** The gating interaction is real and the
  consequences it states are real, but `truncate` and `drop` do not run
  yet — see [Danger zone](#danger-zone).
- Redis keys. There is no structure to describe; the tab says so.

## Design

### Interface

```
payments                       table · public · ~41,203,882 rows   ↻  ▤ rows
 columns  indexes  constraints  triggers  grants  statistics  ddl │ danger zone
──────────────────────────────────────────────────────────────────────────────
 name          type      null       default   comment
 id            uuid      not null   —         —
 …
```

- The header states the object, its kind, its namespace and its row
  count, prefixed `~` when the count is an estimate.
- The selected tab carries a 2px Function Cyan underline; the danger
  zone is dimmed magenta until hovered and underlines magenta when
  selected.
- Primary keys are Snark Magenta, types and definitions Function Cyan,
  metadata Ink mute. Cell tone is a closed set of four rather than a
  free class name, so the tabs cannot drift apart visually.
- `▤ rows` is the one cross-link between the two surfaces: structure
  knows where the data lives and says so, without containing it.

### One call, every tab

`object.describe` returns all seven tabs at once. The tabs are cheap
catalog reads, and a per-tab round trip would make switching tabs feel
like loading a page. The refresh button re-reads the whole thing.

Deep links from the context menu (`indexes`, `danger zone`, …) retarget
an already-open panel, but only when the parameter actually changes —
otherwise the deep link would override every manual tab switch.

### Three kinds of nothing

A tab can be empty for three different reasons, and collapsing them
would be a lie:

| State | How it is expressed | What the user sees |
| --- | --- | --- |
| The object has no such tab | absent from `tabs` | no tab at all |
| The engine cannot answer it | listed in `unsupported` | "sqlite does not expose grants for this object" |
| There is genuinely nothing | present, empty array | "No triggers on this object." |

A function does not have an indexes tab; SQLite cannot answer grants; a
table can simply have no triggers. `tabs` comes from the object's kind
and is known from the panel parameters before the describe lands, so the
tab strip does not reshuffle when data arrives.

### Statistics

Engines disagree about which numbers exist at all, so statistics are a
label/value list rather than a fixed struct: each adapter reports what it
has, formatting happens server-side so the three engines agree on what
"1.2 GB" means, and tiles the engine could not fill are dropped instead
of padded with nulls.

### DDL

| Engine | Source | Verbatim |
| --- | --- | --- |
| PostgreSQL (view) | `pg_get_viewdef` | ✓ |
| PostgreSQL (routine) | `pg_get_functiondef` | ✓ |
| PostgreSQL (table) | rebuilt from the catalog | ✗ |
| PostgreSQL (sequence) | rebuilt from `pg_sequences` | ✗ |
| MySQL | `SHOW CREATE TABLE` / `VIEW` / `FUNCTION` / `PROCEDURE` | ✓ |
| SQLite | `sqlite_master.sql` | ✓ |

A routine is the one thing PostgreSQL *does* export verbatim, body and
all, which is exactly why double-clicking a function goes straight
there.

PostgreSQL has no server-side DDL export — `pg_dump` is a client
program, not a function — so a table's DDL is reconstructed from
columns, constraints and index definitions. The result carries
`ddlReconstructed: true` and the tab says so. Reconstruction is
deliberately careful about two things that a naive rebuild gets wrong:

- **Identity columns.** `generated always as identity` is a column
  clause, not a `DEFAULT`, so it is emitted without the keyword.
- **Constraint-backed indexes.** A unique constraint and its index are
  the same object; emitting both would produce DDL that creates the
  index twice. Only indexes with no owning constraint are appended.

### Per-engine differences

| | postgres | mysql | sqlite |
| --- | --- | --- | --- |
| column comments | `col_description` | `column_comment` | none |
| index sort order | `indoption` bitmask | not exposed | not exposed |
| index size | `pg_relation_size` | unknown | unknown |
| check constraints | `pg_get_constraintdef` | 8.0.16+ only | not exposed |
| trigger timing | `tgtype` bitmask | `action_timing` | parsed from stored SQL |
| disabled triggers | `tgenabled` | cannot be disabled | cannot be disabled |
| grants | `role_table_grants` | `table_privileges` | unsupported |
| row count | `reltuples` (estimate) | `table_rows` (estimate) | `COUNT(*)` (exact) |
| dependents | views + foreign keys | foreign keys | foreign keys |
| routines | functions + procedures | functions + procedures | none |
| sequences | `pg_sequences` | none | none |

**Routine identity.** A PostgreSQL routine's tree name carries its
identity arguments — `order_total(integer, numeric)` — and that whole
string is what selects the row, so overloads stay distinct end to end.
Arguments are read by unnesting the three parallel arrays in `pg_proc`
rather than by parsing `pg_get_function_arguments`: a default value can
contain a comma, so splitting that string is wrong for exactly the
functions people care about.

Two notes on the harder ones:

**Index sort order.** `pg_get_indexdef(oid, k, true)` returns the
column expression without its `DESC`, and slicing the whole definition
instead does not work — a partial index's `WHERE` clause has its own
parentheses and gets swallowed. The direction comes from
`pg_index.indoption` instead, which is also why a partial index reports
only its key columns.

**PostgreSQL row counts.** `reltuples` and `n_live_tup` are both
estimates that go stale differently: `reltuples` is the planner's,
refreshed by `ANALYZE`, and is `-1` before the first one; `n_live_tup`
is the stats collector's and reads `0` until it flushes. `reltuples`
wins so the header agrees with the table view's footer, which estimates
from the same column — and the header always marks it as an estimate.

### Editing columns

The columns tab of a base table is editable: rename, retype, toggle
nullability, set or drop a default, set a comment, add a column, drop a
column. Cells are inputs that read as plain text until touched, so the
tab looks like the read-only grid it replaced; a touched field goes
Gripe Green like a dirty table-view cell.

**The gating is the preview, not a confirmation box.** Edits gather into
a pending set; `review` asks the server for the exact SQL and shows it;
`apply` runs that same batch. A typed confirmation on every field edit
would be noise people learn to dismiss, but reading the statement before
it runs is not — and it teaches what the tool is doing.

`object.alter` serves both steps: `dryRun: true` builds the statements
and stops. One action, one code path, so **the SQL shown cannot drift
from the SQL that executes**. Dropping a column is the exception and
still types the object name, like the danger zone — it is the one change
here that destroys data.

Change order is fixed by the client, not left to the user: attribute
changes, then adds, then renames, then drops. A rename invalidates the
name every other change refers to, and a drop makes the column
unreachable. Touching a column again after renaming it in the same batch
is refused by name rather than sent to fail.

| Change | postgres | mysql | sqlite |
| --- | --- | --- | --- |
| add | ✓ | ✓ | ✓ |
| rename | ✓ | ✓ | ✓ |
| drop | ✓ | ✓ | ✓ |
| type | ✓ | ✓ | – |
| nullability | ✓ | ✓ | – |
| default | ✓ | ✓ | – |
| comment | ✓ | ✓ | – |

`ADAPTER_CAPABILITIES.columnChanges` drives this per operation rather
than all-or-nothing, and the tab disables the fields it cannot change
with the reason in the title. SQLite's `ALTER TABLE` genuinely does only
three things; the rest need the table rebuilt, which this view does not
do (see Open questions).

Two engine differences worth knowing:

- **MySQL has no per-attribute column ALTER.** `MODIFY COLUMN` restates
  the whole definition, so anything not being changed is carried over
  from the column as it currently is — otherwise changing a type would
  silently drop the comment, the default and the nullability.
- **MySQL does not roll DDL back.** Each statement auto-commits, so a
  mid-batch failure leaves the earlier statements applied. The error
  says how far it got rather than implying a rollback that did not
  happen. PostgreSQL and SQLite are transactional and the batch is
  all-or-nothing.

Role is `editor`, matching `table.mutate`. The real gate is the target
database's own permissions: a workspace role says who may drive the
tool, not who may alter a schema.

### Safety

Everything here is a catalog read on the describe path. On PostgreSQL and MySQL the whole
describe runs inside one read-only transaction with a statement timeout;
SQLite needs neither, since its PRAGMAs cannot write. Schema and object
names are bound parameters everywhere except SQLite's PRAGMAs, which
take no binds and get the same defensive quoting the introspection path
already uses.

`object.describe` is open to viewers: structure is read-only
introspection, and unlike the table view's `where …` box there is no
raw fragment for a viewer to smuggle SQL through.

Column changes are a write path and have their own surfaces to guard,
because DDL takes no bind parameters where a type or an identifier goes:

- **Identifiers** are quoted per dialect, quote character doubled.
- **Type names** are validated to a type-shaped pattern — letters,
  digits, spaces, an optional precision, an optional array suffix. That
  admits `numeric(10,2)` and `text[]` and rejects anything containing a
  quote, a semicolon or a call.
- **Default expressions** cannot be allowlisted, since they are real
  expressions. They go through the same dialect-aware statement splitter
  as the table view's filter: a semicolon inside a literal is fine, a
  top-level one is not.
- **Column names** in a change must exist on the relation, read fresh
  from the catalog in the same request.

## Danger zone

The gating is the specification, and it is implemented:

1. **Reveal** — a click expands the action.
2. **Type the object name** — free text, not a checkbox.
3. **Execute** — enabled only on an exact match.

The consequences each action states are now real: actual row counts, the
actual index count, and the actual dependent objects a `DROP` would take
with it, named. Project-class gating is implemented client-side per the
brand spec: `production` confirms with the **project** name rather than
the table name, and `analytics` renders the tab disabled with the reason
stated.

**Neither action executes yet**, and the panel says so rather than
pretending. Two reasons, both deliberate:

- The brand spec's build order puts the danger zone after the object
  view, "deliberately late — it is the one surface where a bug is
  destructive."
- Project class currently lives in `localStorage`
  (`apps/web/src/stores/branding.ts`, marked MOCK). Client-side gating
  on a `DROP TABLE` is theatre: the server cannot enforce "production
  confirms with the project name" while it does not know the class.
  Promoting project class to the workspace model is the prerequisite,
  and it belongs to the projects feature rather than to this one.

## Open questions

- Where does the gripes engine hang off this? The brand spec says
  object-scoped gripes slot in as a tab. Whether that is a tab or an
  annotation rail beside the existing tabs is undecided.
- **The ddl tab of a routine is the best place in the product to look
  for gripes**, and nothing looks yet. A function body is dense with
  checkable things — a `VOLATILE` marking on a body that only reads, a
  `SECURITY DEFINER` without a `search_path`, a scan the enclosing table
  has no index for — and unlike a table's shape, the body is right there
  to annotate. Deliberately not built here: the brand spec calls the
  rule catalogue "the actual product" and reserves it for its own design
  pass, so picking rules in passing would prejudge it.
- SQLite's narrow `ALTER TABLE` means type, nullability and default
  changes need the 12-step table rebuild (new table, copy, drop,
  rename). It is well documented and entirely doable, but it is a data
  migration wearing a schema change's clothes, and it deserves deciding
  on rather than sliding in.
- Index, constraint and trigger tabs are read-only. The columns tab
  proves the preview-then-apply shape works; extending it is mostly more
  dialect SQL.
- The spec lists partitions, dependencies, policies, comments and bloat
  estimates as natural future tabs. Adding them is easy; deciding which
  earn a tab rather than a row in `statistics` is not.
- SQLite check constraints are not exposed by any PRAGMA. Parsing them
  out of the stored `CREATE TABLE` is possible and would make the
  constraints tab complete, at the cost of a SQL parser in the adapter.
- MySQL per-index size needs `innodb_index_stats`, which needs
  privileges the connection may not have. Reporting unknown is honest;
  attempting it and degrading is also defensible.
