# Spec — Object view

**Status:** current
**Phase:** 9
**Supersedes:** nothing (implements `docs/brand/brand-system.md`
"Object view — the structure" and "Danger zone"; the tab strip follows
`docs/brand/mocks/tree-interactions.html`)

## Goal

The `⊞` affordance, or any structure entry in the tree's context menu,
opens one relation's structure as an editor tab: columns, indexes,
constraints, triggers, grants, statistics, ddl — and the danger zone,
pushed to the right edge behind a divider.

## Non-goals

- **A data tab.** Rows are the table view's job
  (`docs/spec/table-view.md`). That separation is what lets both
  surfaces be generous with space, and it is the reason the object view
  can grow tabs without a redesign.
- DDL editing, or any structural change. The tabs are read-only.
- **Executing the danger zone.** The gating interaction is real and the
  consequences it states are real, but `truncate` and `drop` do not run
  yet — see [Danger zone](#danger-zone).
- Routines, sequences and Redis keys. The object view describes
  relations; other tree leaves have no structure to show.

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

### Empty versus unanswerable

A tab with nothing in it and a tab the engine cannot answer look
identical, and the difference matters: "this table has no triggers" and
"SQLite has no permission system" are different facts. The result
carries an `unsupported` list, and the client renders the engine's name
in the explanation rather than an empty table.

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
| PostgreSQL (table) | rebuilt from the catalog | ✗ |
| MySQL | `SHOW CREATE TABLE` / `VIEW` | ✓ |
| SQLite | `sqlite_master.sql` | ✓ |

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

### Safety

Everything here is a catalog read. On PostgreSQL and MySQL the whole
describe runs inside one read-only transaction with a statement timeout;
SQLite needs neither, since its PRAGMAs cannot write. Schema and object
names are bound parameters everywhere except SQLite's PRAGMAs, which
take no binds and get the same defensive quoting the introspection path
already uses.

`object.describe` is open to viewers: structure is read-only
introspection, and unlike the table view's `where …` box there is no
raw fragment for a viewer to smuggle SQL through.

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
- The spec lists partitions, dependencies, policies, comments and bloat
  estimates as natural future tabs. Adding them is easy; deciding which
  earn a tab rather than a row in `statistics` is not.
- SQLite check constraints are not exposed by any PRAGMA. Parsing them
  out of the stored `CREATE TABLE` is possible and would make the
  constraints tab complete, at the cost of a SQL parser in the adapter.
- MySQL per-index size needs `innodb_index_stats`, which needs
  privileges the connection may not have. Reporting unknown is honest;
  attempting it and degrading is also defensible.
