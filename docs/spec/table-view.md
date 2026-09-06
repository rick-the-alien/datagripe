# Spec — Table view

**Status:** current
**Phase:** 8
**Supersedes:** nothing (implements `docs/brand/brand-system.md`
"Table view — the data"; the grid chrome follows
`docs/brand/mocks/tree-interactions.html`)

## Goal

Double-clicking a table or view in the tree opens its rows as an editor
tab and lets you work with them: browse, sort, filter, page, export,
inspect a large value, edit a cell, insert a row, delete a row.

The table view is a separate surface from query execution. It does not
go through `execution.start`, has no statement history, and never shows
up in the results panel — a grid on one relation and an ad-hoc result
set have different affordances, and conflating them costs both.

## Non-goals

- Editing views, or tables without a primary key. Both are browsable;
  neither can be written, because there is no predicate that provably
  addresses one row. The footer states the reason; turning "this table
  has no primary key" into a gripe is `docs/spec/gripes.md`.
- Multi-row bulk edits, `UPDATE … WHERE <filter>`, or find-and-replace.
  Every write here is one row.
- DDL. Structure is the object view's job
  (`docs/spec/object-view.md`), and destructive operations live behind
  its danger zone.
- Keyset pagination. `LIMIT`/`OFFSET` is what a human paging through a
  grid needs; deep offsets on huge tables are slow and that is
  acceptable for now (see Open questions).
- Client-side sorting or filtering. Both are pushed to the database, so
  they apply to the whole relation rather than the fetched page.

## Design

### Interface

One line of chrome, then rows. Real estate goes to data.

```
⟳   [where … ]   100 rows ▾   ‹ 1–100 ›   [commit 3] [revert]      ⬇ ⧉ ▾   ⋯
─────────────────────────────────────────────────────────────────────────────
 #  id      user_id   amount   currency   status    …
─────────────────────────────────────────────────────────────────────────────
 …rows…                                                        │ value panel │
─────────────────────────────────────────────────────────────────────────────
100 of ~41,203,882 rows                     read only until you edit a cell
```

- Row numbers in Ink faint and offset-absolute, primary key in Snark
  Magenta, numerics right-aligned and coloured, everything else neutral.
- Sticky header. Clicking a header cycles asc → desc → unsorted;
  shift-clicking appends a second sort key instead of replacing.
- The row limit is a menu (100 / 200 / 500 / 1,000), not a text field.
  Default 100.
- The `where …` box takes a raw predicate, applied on Enter and cleared
  on Escape. It is spliced into `WHERE`, not parsed.
- The footer states the count and the edit state.
- Export is the same joined group as the results panel
  (`ExportControls`): one format setting drives download and clipboard.
- The overflow menu holds what is a mode rather than a constant:
  transpose, value panel, insert row, delete row.
- **Commit and revert only exist while there is something to commit.**
  Permanent chrome for a transient state trains people to ignore it.

**Transpose** flips the page: columns become rows and each fetched row
becomes a column, headed by its row number. Cells stay editable, since
addressing a cell does not depend on the orientation.

**The value panel** is a right-hand pane inside the tab, not a modal. It
shows the focused cell in full, pretty-printed when the value is JSON —
which is what makes a `jsonb` column readable at all — plus `copy` and
`set null`.

### Editing

The grid is read-only until a cell is edited. Double-click (or Enter /
F2 on a focused cell) opens an inline editor; Enter commits to the
pending set, Escape abandons it, Ctrl/Cmd+Backspace makes the cell NULL.

Pending state is local until committed, and shows through the cells:
edited green, draft rows violet, rows marked for deletion struck through
in magenta. `commit` sends the whole batch; `revert` throws it away.

A refresh — explicit, or implicit after a commit — discards pending
edits. Rows are addressed by their index in the fetched page, and after
a re-sort index 4 is a different row.

**Cell values travel as tagged inputs**, not JSON scalars:

| Input | Meaning |
| --- | --- |
| `{kind: "text", text}` | bind this text; the database casts it |
| `{kind: "null"}` | SQL NULL |
| `{kind: "default"}` | omit the column and let the database decide |

An empty string, NULL, and "use the default" are three different
intents, and JSON alone cannot tell them apart. A new draft row starts
with every writable column at `default`, so committing an untouched
draft inserts a defaults-only row rather than a wall of empty strings.

Deletes are ordered last within a batch, so a row that was edited and
then deleted in the same session does not fail its update against a row
that no longer exists.

### Protocol

Two actions (`packages/contracts/src/tables.ts`):

| Action | Minimum role | Notes |
| --- | --- | --- |
| `table.rows` | viewer | rate-limited; a non-empty `filter` needs editor |
| `table.mutate` | editor | idempotent by `idempotencyKey` |

`table.rows` returns the column list with `primaryKey` / `generated` /
`hasDefault` flags, the page as arrays in column order, the total row
count, and `editable` with a `reason` when false. The client renders the
reason in the footer rather than inventing its own explanation.

`table.mutate` applies every edit in one transaction and rolls the whole
batch back unless each statement affected exactly one row.

### Safety

The `where …` box is the only place in this feature where user text
becomes SQL. Everything else is quoted or bound:

- Schema, table and column identifiers are quoted per dialect, with the
  quote character doubled.
- Sort columns must appear in the relation's real column list.
- An edit's `key` must be **exactly** the primary key column set — not a
  subset, not a superset, not some other column. That is what makes a
  mistyped identity a failed statement rather than a mass update.
- Write targets are checked against the real column list, and generated
  or identity-always columns are refused.
- Values are bound parameters.

The filter itself is checked with the dialect-aware statement splitter:
a semicolon inside a string literal is fine, a top-level one is not, so
the filter cannot stack a second statement. Reads then run inside a
read-only transaction with a statement timeout, so even an expression
that gets past the splitter cannot write.

`execution.start` is editor-only, which means viewers deliberately
cannot run arbitrary SQL. A raw predicate is arbitrary read SQL, so
`table.rows` refuses a non-empty filter from a viewer and the client
disables the box. Unfiltered browsing, sorting and paging stay open to
viewers.

### Row counts

An exact `COUNT(*)` on a 40M-row table costs seconds to produce a number
nobody reads to the digit. So: when there is no filter, the planner
estimate is taken first (`pg_class.reltuples`,
`information_schema.tables.table_rows`), and above
`estimateAboveRows` (100,000) it is reported as-is and prefixed `~` in
the footer. Below that, or whenever a filter is active, the count is
exact. SQLite has no estimate and always counts.

### Capabilities

`ADAPTER_CAPABILITIES.tableData` gates the whole surface:
`"readwrite"` for PostgreSQL, MySQL and SQLite, `null` for Redis, whose
objects are not relations. The tab explains itself rather than
rendering an empty grid.

Per-engine differences that could not be abstracted away:

| | postgres | mysql | sqlite |
| --- | --- | --- | --- |
| placeholders | `$n` | `?` | `?` |
| identifier quote | `"` | `` ` `` | `"` |
| all-defaults insert | `DEFAULT VALUES` | `() VALUES ()` | `DEFAULT VALUES` |
| `SET col = DEFAULT` | ✓ | rejected | rejected |
| read isolation | `BEGIN READ ONLY` | `START TRANSACTION READ ONLY` | none needed |
| row estimate | `reltuples` | `table_rows` | none |

Driver-native values are flattened before they cross the wire: `bigint`
to a string (JSON.stringify throws on it outright), `Date` to ISO,
bytes to a `\x…` hex literal. The grid is a text surface and every
value has to survive the round trip back through an input box.

## Open questions

- Deep `OFFSET` on a large table is slow. Keyset pagination would fix it
  but needs a stable unique sort key, which the "sort by any column"
  affordance does not guarantee. Unresolved on purpose.
- Editing is only offered for base tables with a primary key. Postgres
  can address a row by `ctid` and MySQL/InnoDB by unique index, which
  would widen coverage at the cost of a per-engine identity concept.
- The value panel shows one cell. A whole-row form (the DataGrip
  "row editor") may be the better shape for wide tables.
- Concurrent edits are last-write-wins within the single-row guard.
  Optimistic concurrency over every column, or a `xmin` check, is a
  bigger decision than this spec should make.
