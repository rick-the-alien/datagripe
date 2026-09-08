# Spec — Domains

**Status:** current
**Phase:** 12
**Supersedes:** nothing (extends `docs/spec/connections.md`,
`docs/spec/workspaces.md`, `docs/spec/object-view.md`; the export's
access reports are specified in `docs/spec/access-report.md`)

## Goal

A schema is a flat pile of objects; a database is not. `public` holds
tables that belong to authentication, to aggregation, to reporting, and
nothing in the catalog says so. A **domain** is a user-maintained label
for that missing dimension: every table, view, routine and sequence can
carry one, the sidebar can group and colour by it, and the whole tagging
plus the DDL it implies can be exported to a directory tree that lives
in the project's git repository.

The exported tree is the artifact people already hand-maintain as a
shell script — a `declare -A TABLE_DOMAIN` map beside a pile of
`pg_dump --table=` invocations, which silently omits every object added
since the map was last edited. DataGripe already knows the object list
and already produces DDL for each object; the only thing it lacks is the
label. Once it has the label, the script is a button.

## Non-goals

- Domains are not a security boundary. They do not affect grants,
  visibility, or which objects a query can touch.
- Not a replacement for schemas. An object's namespace still comes from
  the engine; a domain cuts across namespaces.
- Not nested. One flat list per datasource (see "Flat, deliberately").
- Not multi-tag. An object has at most one domain, because the sidebar
  expresses the tag as a single colour rail.
- Not migration generation. The export is a snapshot of current
  structure, not an ordered, runnable rebuild script. See
  "What the export is not".
- No automatic tagging in the first phase. Suggestions are phase 3.
- Not the access report. The dump contains one and the sync tab links
  to it, but role × object grants are `docs/spec/access-report.md`.

## Definitions

| Term | Meaning |
| --- | --- |
| Domain | A named, coloured label scoped to one datasource in one workspace |
| Tag | The assignment of one object to one domain |
| Untagged | An object the datasource reports that carries no tag |
| Domain root | The allowlisted directory the export writes into |
| Dump | The exported tree plus its manifest, as committed to git |
| Drift | A tag whose object no longer exists, or an object no domain claims |

## Design

### Scope: workspace × datasource

A domain belongs to a `(workspace_id, connection_ref)` pair, not to a
workspace and not to a connection alone. Two datasources in one
workspace — a production database and its analytics replica — deserve
their own domain lists even when the schemas rhyme, and the same
connection reached from two workspaces is two different projects'
opinions about the same database.

`connection_ref` is `ConnectionMetadata.id` — the same string the
explorer, the object view and the table view already pass as
`connectionId`. For a managed connection that is its UUID; for a
predefined one it is the bare slug from `CONNECTIONS_FILE`
(`local-demo`), **not** the `predefined:<slug>` form.

Those two shapes both exist in the codebase and it is worth being
explicit about which one this is: `workspaces.default_connection_ref`
uses the prefixed form, while every per-object action uses the bare id.
Domains follow the actions, because a domain is looked up in the same
breath as the objects it tags.

Deleting a managed connection leaves rows behind — `connection_ref` is
text, not a foreign key, since a predefined slug has no row to reference
— and a predefined connection disappearing from `CONNECTIONS_FILE` does
the same. `domain.list` only ever returns rows for a ref the caller
asked about, so orphans are inert rather than wrong.

### Flat, deliberately

Hand-built trees drift toward paths — `source/sync/rival`,
`infrastructure/util`. Domains stay one level, and a name may contain
`-` to say the same thing: `sync-rival`, `infra-util`. The reasons are
concrete rather than aesthetic:

- The colour rail carries exactly one colour. A child inheriting its
  parent's colour makes the rail ambiguous; a child overriding it makes
  the parent's colour a lie.
- Grouping the tree by domain adds a level of indentation to a sidebar
  the brand spec has already cut to three
  (`docs/brand/brand-system.md` "Sidebar / Structure").
- The export path is `domains/<name>/`, one segment, so a rename is a
  single directory rename in the diff.

Nesting is recorded as an open question, not a rejected idea; the tag
model does not need to change to add a `parent_id` later.

### Storage

Migration `0010_domains.sql`:

```sql
CREATE TABLE domains (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	-- Managed UUID or `predefined:<slug>`; text because both shapes fit.
	connection_ref text NOT NULL,
	-- Lowercase, [a-z0-9-], because it becomes a directory name.
	name text NOT NULL CHECK (name ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
	-- Palette slot, not a hex value: the theme owns the hue.
	colour smallint NOT NULL CHECK (colour BETWEEN 1 AND 8),
	description text NOT NULL DEFAULT '',
	-- Manual ordering in the manager and in the grouped tree.
	sort_order integer NOT NULL DEFAULT 0,
	-- Reference/config domains export INSERTs alongside their DDL.
	include_data boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX domains_unique_name
	ON domains (workspace_id, connection_ref, name);

CREATE TABLE domain_tags (
	domain_id uuid NOT NULL REFERENCES domains (id) ON DELETE CASCADE,
	-- Namespace and name exactly as the explorer tree shows them, so a
	-- PostgreSQL routine name carries its identity arguments and
	-- overloads tag independently.
	schema text NOT NULL,
	name text NOT NULL,
	kind text NOT NULL CHECK (kind IN
		('table', 'view', 'function', 'procedure', 'sequence')),
	tagged_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	tagged_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (domain_id, schema, name, kind)
);

-- Finding an object's current tag means looking across every domain of
-- the datasource, so the lookup leads with the object, not the domain.
CREATE INDEX domain_tags_object ON domain_tags (schema, name, kind);

-- Export run history (see "Run history"). Not keyed to `domains`: a run
-- covers the datasource, and it must survive every domain in it being
-- deleted.
CREATE TABLE domain_exports (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	connection_ref text NOT NULL,
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz,
	actor uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	domain_count integer NOT NULL DEFAULT 0,
	object_count integer NOT NULL DEFAULT 0,
	written integer NOT NULL DEFAULT 0,
	deleted integer NOT NULL DEFAULT 0,
	refused integer NOT NULL DEFAULT 0,
	outcome text NOT NULL CHECK (outcome IN ('ok', 'failed', 'refused')),
	error text,
	-- Set when the run was committed from the sync tab.
	commit_sha text
);

CREATE INDEX domain_exports_recent
	ON domain_exports (workspace_id, connection_ref, started_at DESC);
```

The primary key stops an object being tagged twice into the *same*
domain. The stronger "at most one domain per object" rule cannot be a
constraint on `domain_tags` at all, because the datasource identity
lives on `domains`.
It is enforced in the service: `domain.tag` deletes any existing tag for
the target across every domain of that `(workspace_id, connection_ref)`
before inserting, in one transaction. A test asserts the invariant
directly against the database rather than through the API.

Tags are **team-wide**, like gripe dismissals
(`docs/spec/gripes.md` "Dismissal"): a domain is a fact about the
schema, not a personal bookmark. `tagged_by` is stored so the decision
can be revisited without losing who made it.

### Actions (WebSocket)

| Action | Min role | Behaviour |
| --- | --- | --- |
| `domain.list` | viewer | Domains plus every tag for one `connectionRef` |
| `domain.upsert` | editor | Create or update name, colour, description, order, `includeData` |
| `domain.delete` | editor | Deletes the domain; its objects become untagged. Response reports the count. |
| `domain.tag` | editor | Batch assign: `{ targets: [...], domainId \| null }`. `null` untags. |
| `domain.export` | owner | Writes the dump. `dryRun` returns the plan without touching disk. |
| `domain.import` | owner | Reads a manifest back and replaces the tag set |
| `domain.runs` | viewer | Export run history for one `connectionRef` |
| `domain.git` | owner | `status` / `commit` / `push` against the domain root |
| `domain.set-export-path` | editor | The datasource's export directory. Editor, like the settings it sits beside; *using* it still needs `owner` |

`domain.upsert`, `domain.tag` and `domain.export` carry an
`idempotencyKey` and replay through `idempotency_keys` like every other
mutation.

Export runs long — one `object.describe` per tagged object — so it
broadcasts `domain.export.progress` over the hub (`{ done, total,
current }`) and the client shows a determinate bar. The final response
is the plan that was executed.

Contracts live in `packages/contracts/src/domains.ts`.

### Sidebar

A **group by domain** toggle (`⌗`) sits in the tree's filter row, beside
the object filter, with `⋯` for the domain manager next to it. It is a
view mode, not a filter: every object stays reachable in both modes, and
each mode keeps its own expansion state so toggling does not collapse
the tree you were reading.

```
┌─────────────────────────────┐
│ wallet-prod / public     ▾  │
├─────────────────────────────┤
│ filter objects…       ⌗  ⋯  │  group-by-domain · manage
├─────────────────────────────┤
│▍▸ auth                   6  │  domain row, colour rail
│▍  ▤ basic_auth.users        │  schema-qualified: domains cut across
│▍  ▤ basic_auth.sessions     │
│▍  ƒ login                   │
│▍▸ aggregation           23  │
│▍▸ reference              6  │
│ ▸ untagged               4  │  Ink dim, no rail, always last
└─────────────────────────────┘
```

- Object rows inside a domain group are **schema-qualified**, because
  the point of a domain is that it crosses namespaces.
- **`untagged` is always present and always last**, even at zero, and
  its count is the number that matters: it is the drift the shell script
  could never show. At zero it renders in Ink faint like any synthetic
  empty row.
- In the normal (schema-first) mode, tagged rows keep their colour rail.
  This is the mode most people stay in, and the rail is what makes a
  mis-tagged table visible without switching views.
- Grouping needs the full object list for the schema, so switching to
  grouped mode forces the lazy category loads the tree would otherwise
  defer. The domain rows render immediately with `loading…` children,
  per the brand spec's rule that fetching must not look like empty.

### The colour rail

A 3px rail at the row's left edge, full row height, using
`--dg-border-accent-row`. Rules:

- The rail says **domain**, never severity and never project class. The
  sidebar tree carries no severity marks today (those live on the object
  view's tab strip, `docs/spec/gripes.md`), and this spec keeps it that
  way — introducing both to the same surface would make one of them
  unreadable.
- Domain hues therefore may **not** be the four project accents. The
  eight palette slots need their own tokens (`--dg-domain-1` …
  `--dg-domain-8`), muted against the brand accents so a magenta-ish
  domain can never be mistaken for a production connection.
- The hex values are **reserved for the brand pass**, the same way the
  gripe catalogue's wording was. This spec fixes the count (eight), the
  token names, and the constraint; `docs/brand/brand-system.md` fixes
  the values.
- Colour is never the only carrier: the domain name is on the group row,
  and the field popover and object-view header both name the domain in
  text.

### Context menu

The existing menu (`docs/brand/brand-system.md` "Context menu") grows one
entry above `copy name`:

```
view rows                  dbl click
──────────────────────────
columns … ddl
──────────────────────────
domain                            ▸ ┌──────────────────┐
copy name                           │▍auth             │
──────────────────────────          │▍aggregation    ✓ │
danger zone…                        │▍reference        │
                                    │ ─────────────────│
                                    │ untag            │
                                    │ new domain…      │
                                    └──────────────────┘
```

- Each submenu item carries its colour rail and a `✓` on the current
  domain. `untag` appears only when the object is tagged.
- Ctrl/Cmd click adds an object to a multi-selection, and with one
  active the submenu applies to all of it — the header reads
  `domain (7 objects)` and mixed current domains show no check, because
  a tick describing one of seven would be a lie. The right-clicked row
  joins the batch even if it was not selected, because it is what the
  pointer is on. A plain click clears the selection: leaving it live
  after you have obviously moved on is how a bulk action hits the wrong
  two hundred objects.
- `new domain…` opens the manager with the name field focused and the
  pending assignment queued, so creating and tagging is one gesture.

### Domain manager

A **tab**, opened from the breadcrumb overflow, the tree header's `⋯`, or
`new domain…`. Not a modal: the rest of the app already decided that
forms are tabs, so this one survives navigation and can sit beside the
tree it describes (`docs/brand/mocks/datasource-selector.html`).

One row per domain: colour swatch, name, description, object count,
`include data` checkbox, delete. Deleting shows the object count that is
about to become untagged and requires confirmation — a domain with 30
tags is 30 decisions.

The untagged count lives in the grouped tree and in the sync tab's scope
line rather than here.

**Not built yet:** manual reordering (`sort_order` exists and is honoured;
nothing sets it but creation order), and the stale-tag report — tags
whose object the datasource no longer reports, with a "remove all"
action. Stale tags are what a hand-maintained map accumulates silently,
so this is the more valuable of the two.

### Export

`domain.export` writes a deterministic tree under the workspace's domain
root:

```
<domain root>/
  manifest.json
  domains/
    auth/
      tables/basic_auth.users.sql
      tables/basic_auth.sessions.sql
      routines/public.login__integer-text.sql
      views/public.v_sessions.sql
    aggregation/
      tables/public.agg.sql
      sequences/public.agg_id_seq.sql
    reference/
      tables/public.casinos.sql
      data/public.casinos.sql
  access/
    matrix.md          # roles × objects — docs/spec/access-report.md
    rls-policies.md
    default-acl.md
    findings.md
  pull.log
```

- One file per object. The filename is `<schema>.<name>.sql`, schema
  included because `basic_auth.users` and `public.users` are two files.
- A PostgreSQL routine's name carries its identity arguments, which are
  not filesystem-safe. The file is
  `<schema>.<name>__<argslug>.sql`, where `argslug` lowercases the
  identity arguments and replaces every run of non-alphanumerics with
  `-`; over 48 characters it truncates and appends `-` plus the first 8
  hex of the argument list's SHA-256. Overloads stay distinct files and
  stay stable across exports.
- Subdirectories are `tables/`, `views/`, `routines/`, `sequences/`,
  `data/`. Functions and procedures share `routines/`, because the
  distinction is already in the DDL and a `procedures/` directory that
  is empty on every engine but MySQL is noise.
- File bodies carry the object's DDL, then its grants. The grant block
  is not decoration: under PostgREST a `CREATE FUNCTION` without one
  tells a reviewer nothing about whether the function is an endpoint.
  Grants to `PUBLIC` are written out explicitly, including PostgreSQL's
  implicit default `EXECUTE` on routines, so the default is visible in
  the diff. Full rules in `docs/spec/access-report.md`, "Grants in the
  per-object DDL".
- The DDL itself is exactly what the object view shows
  (`docs/spec/object-view.md` "DDL"), one adapter path for every engine
  — verbatim on MySQL/SQLite, reconstructed on PostgreSQL, and
  `pg_get_functiondef` verbatim for routines. **No external binary**: no
  `pg_dump`, no `psql`, no version-skew between the client tools on the
  server and the database being read.

#### Determinism is the requirement

An export that churns is an export nobody commits. Every rule below
exists so that re-running against an unchanged database produces a
byte-identical tree and an empty `git diff`:

- Domains in name order; objects in `(schema, name, kind)` order.
- No timestamps, hostnames, server versions, row counts, sizes or oids
  in any generated file body. `statistics` is live data and is never
  exported.
- `manifest.json` is serialised with sorted keys, two-space indent, and
  a trailing newline.
- Every `.sql` file ends with exactly one newline.
- Data dumps are ordered by primary key. A table with `includeData` and
  **no primary key** is refused with a named error rather than exported
  in whatever order the engine felt like — unstable ordering would put a
  thousand-line diff in front of you on every pull.
- Data dumps are single-row `INSERT` statements with explicit column
  lists, capped at `DOMAIN_EXPORT_MAX_DATA_ROWS` (default 10,000) per
  table; exceeding the cap fails that table and reports it, rather than
  writing a truncated file that looks complete.

#### The manifest

`manifest.json` is the round-trip source of truth and the only file the
import reads:

```json
{
  "version": 1,
  "connection": { "ref": "predefined:wallet-prod", "name": "wallet-prod", "engine": "postgres" },
  "domains": [
    { "name": "auth", "colour": 1, "description": "", "includeData": false,
      "objects": [
        { "schema": "basic_auth", "name": "users", "kind": "table" },
        { "schema": "public", "name": "login(text, text)", "kind": "function" }
      ] }
  ]
}
```

It records `ref` and `name` so an import can match by reference first
and fall back to the human name when the dump came from a different
checkout. It records the engine so an import into the wrong engine
fails loudly. It contains **no host, no port, no user, no credential of
any kind** — the manifest is committed to a repository, and a
connection string in git is the accident this project exists to
complain about.

#### Prune, and dry run first

An export owns everything under `domains/` and `access/` plus the two
top-level files, and nothing else. Files under those two directories
that this export did not generate are deleted, so renaming a domain or untagging a table removes
its file instead of leaving a stale one to be read as truth a year later.

Because that deletes files in a git working tree, export follows the
`object.alter` precedent (`docs/spec/object-view.md` "Editing columns"):
**`dryRun` first**. The plan lists writes, unchanged files, deletions and
refusals, and the user runs it only after reading it. A plan whose
deletion count is non-zero says so at the top.

`pull.log` is append-only and is the one file allowed to be
nondeterministic: one line per export with timestamp, actor, object
count and a written/deleted tally. It is excluded from the prune.

#### Where it may write

- `DOMAIN_EXPORT_ROOTS` — a colon-separated list of absolute
  directories, empty by default. **Empty means export is disabled**, and
  the UI says so rather than offering a button that always fails.
- `datasource_export_paths` holds the chosen directory, keyed by
  `(workspace_id, connection_ref)` — **per datasource, not per project**
  (migration 0012). An export never crosses a datasource boundary, so a
  single path per workspace would have two datasources overwriting each
  other's tree, silently, because both trees are structurally valid.
- It is set on the **datasource edit page**, beside the other
  per-datasource settings, and saved by `domain.set-export-path` rather
  than `connection.update`. That matters for predefined connections:
  `connection.update` refuses them outright, and the export path has to
  be settable on one. It can be, because the path is not part of the
  datasource — it is what this project does with it.
- A table rather than a column on `connections`, because a predefined
  connection has no row there.
- On every export the server resolves the path with `realpath`, then
  requires the result to be a path-segment prefix match against one
  allowlisted root — segment-wise, so `/srv/repos-evil` does not pass
  for `/srv/repos`. Validation happens at export rather than at save, so
  a directory created later still works.
- The resolution happens per export, not once at configuration time, so
  a symlink swapped in afterwards is caught.
- Every generated path is re-checked after joining, and any component
  that is not `[A-Za-z0-9._-]` fails the export. Object names come from
  a database that a user may control; a schema called `../../etc` gets a
  named error, not a write.
- Export is `owner`-only. It is the one action in the app that writes to
  the host filesystem.
- The desktop app (`apps/desktop`) sets `DOMAIN_EXPORT_ROOTS` to the
  user's home directory by default; hosted deployments set it
  explicitly or leave export off.
- `DOMAIN_EXPORT_GIT` (default off) and `DOMAIN_GIT_TIMEOUT_MS` (default
  60,000) gate and bound the commit path — see "Committing".

### The sync tab

Export is not a modal. It is a dock tab, `sync: <datasource>`, because
what it produces is a run you watch, read the output of, and act on —
and because a modal cannot stay open beside the diff it just made.

```
┌──────────────────────────────────────────────────────────────┐
│ sync: wallet-prod                                            │
├──────────────────────────────────────────────────────────────┤
│ target   ~/repos/falsedynasty/datasource/schema              │
│          (set on the datasource's edit page)                 │
│          git · main · 4 files changed                        │
│ scope    9 domains · 87 objects · 4 untagged                 │
├──────────────────────────────────────────────────────────────┤
│  [ dry run ]  [ export ]                                     │
│                                                              │
│  ████████████████░░░░░░░░  61/87  public.transactions        │
├──────────────────────────────────────────────────────────────┤
│ plan                                                         │
│   82 unchanged                                               │
│    4 written    domains/source/tables/public.players.sql  …  │
│    1 deleted    domains/media/tables/public.tags.sql         │
│    1 refused    public.audit_log — includeData, no primary   │
│                 key, so row order would churn every export   │
├──────────────────────────────────────────────────────────────┤
│  [ commit… ]  [ commit and push… ]                           │
├──────────────────────────────────────────────────────────────┤
│ history                                                      │
│  2026-09-07 14:02  rick   87 objects  4 written  1 deleted  ✓│
│  2026-09-01 09:40  rick   85 objects  85 written             │
│  2026-08-24 16:11  sam    85 objects  0 written  (no change) │
└──────────────────────────────────────────────────────────────┘
```

The three sections answer the three questions in order: what am I
pointed at, what is about to happen, what happened before.

- **Refusals are first-class.** A table skipped because `includeData` is
  on and it has no primary key gets a line and a reason, never a silent
  omission. Silent omission is the failure mode of the scripts this
  replaces.
- **Untagged is in the scope line**, not buried in the manager. The
  number of objects the export is *not* going to write is as important
  as the number it will.
- The `access/` reports (`docs/spec/access-report.md`) are generated as
  part of the run, and the tab links to the access tab rather than
  inlining a matrix.

### Run history

`domain_exports` (migration 0010), one row per completed run:
`workspace_id`, `connection_ref`, `started_at`, `finished_at`, `actor`,
`domain_count`, `object_count`, `written`, `deleted`, `refused`,
`outcome` (`ok` / `failed` / `refused`), `error`, and the git commit sha
when one was made.

Server-side rather than parsed back out of `pull.log`, because it is
attributable, queryable and survives the working tree being cleaned.
`pull.log` still exists and still gets a line: it travels in the
repository for people reading the dump without DataGripe, and it is
derived from the same row.

A run whose export fails partway writes a row with `outcome = failed`
and the error. A dry run writes nothing — it did nothing.

### Committing

The dump exists to be committed, so the last mile is in the tab.

`domain.git` runs the local `git` binary in the resolved domain root.
There is no credential management here and none is planned: DataGripe
runs git the way you would, with your ambient configuration, and if the
push has no credentials the push fails and you get git's own stderr,
verbatim, in the tab. That is the correct amount of opinion for this
feature to have.

What it does have opinions about:

- **Off by default.** `DOMAIN_EXPORT_GIT` gates it; the buttons are
  absent, not disabled-with-a-tooltip, when it is off.
- **`owner` role**, like export. It writes to the host and talks to a
  remote.
- **argv, never a shell.** `Bun.spawn` with an argument array and no
  shell interpretation. The commit message is one argv element, so a
  message of `--amend` is a message.
- **A fixed verb list**: `rev-parse --show-toplevel`,
  `status --porcelain`, `add --`, `commit -m`, `push`, and `log` for the
  sha. No user-supplied flags reach any of them.
- **`git add` is scoped to the domain root pathspec.** The repository
  almost certainly has other work in progress; an export must never
  stage it. This is the constraint most likely to be dropped during
  implementation and the one most likely to be noticed by ruining
  somebody's afternoon.
- The domain root must be inside the work tree `rev-parse` reports, or
  the operation refuses.
- `GIT_TERMINAL_PROMPT=0` and an askpass that fails immediately, so a
  credential prompt is an error instead of a process that hangs until
  the timeout. `HOME`, `PATH` and `SSH_AUTH_SOCK` pass through, because
  that is where working credentials live.
- Every invocation has a timeout (`DOMAIN_GIT_TIMEOUT_MS`, default
  60,000) and is killed at it.
- stdout and stderr are streamed to the tab verbatim and the exit code
  is the verdict. No interpretation, no "something went wrong".
- Every invocation writes an audit line, and a commit records its sha
  against the run.

**Push is always a separate, explicit press.** It is never bundled into
export and never automatic, because it is the only action in this spec
that leaves the machine. `commit…` and `commit and push…` both show the
`git status --porcelain` of the domain root and the message field before
they run anything.

### Import

`domain.import` reads `manifest.json` from the domain root and replaces
the datasource's domains and tags with what it finds. It is how a
teammate who pulls the repo gets your tagging, and how tagging survives
a workspace being recreated.

It is a **replace**, previewed as a diff — domains added, removed,
recoloured, and tags moved — and applied in one transaction. Tags for
objects the datasource does not currently report are imported anyway and
show up as stale in the manager, because the alternative is silently
losing a tag while a migration is mid-flight.

Import does not read the `.sql` files. They are output.

### What the export is not

It is a **structure snapshot**, in the same sense the object view's DDL
tab is: per-object DDL, no dependency ordering, no `CREATE SCHEMA`, no
extension setup. Running the whole tree top to bottom against an empty
database will fail on the first forward reference. That is fine — the
artifact exists to be read and diffed in code review, which is what the
scripts it replaces were used for too. Migration generation stays in the
parking lot.

## Testing

- Determinism: export twice against a fixture database, assert the two
  trees are byte-identical, including the manifest.
- Path safety: a schema named `../../etc`, a name with a null byte, a
  domain root that is a symlink into `/tmp`, a root outside the
  allowlist, and the `/srv/repos-evil` prefix case each get a named
  error and write nothing.
- One-domain invariant: tagging an already-tagged object moves it, and a
  direct database query finds exactly one row.
- Prune: untag an object, re-export, assert its file is gone and nothing
  outside `domains/` and `access/` was touched.
- Round trip: export, delete every domain, import, assert the tag set is
  identical.
- Refusals: `includeData` on a table with no primary key, and a table
  over the row cap, both fail that object and leave the rest of the
  export intact.
- Drift: a tag whose object was dropped appears as stale and never as a
  silent omission.
- Grouped tree: a domain containing objects from two schemas renders both
  schema-qualified under one group.
- Git scoping: with an unrelated modified file elsewhere in the
  repository, commit stages and commits only the domain root.
- Git argv: a commit message of `--amend` produces a commit with that
  message and does not amend.
- Git refusal: a domain root outside any work tree, and a work tree
  whose root does not contain the domain root, both refuse and run
  nothing.
- Git failure: a push with no credentials surfaces git's stderr and a
  non-zero exit, and does not hang waiting for a prompt.
- Run history: a failed export records `outcome = failed` with the
  error; a dry run records nothing.

## What is not built

- **Suggestions.** A domain carrying ordered glob patterns (`agg*`,
  `sync_rival_*`) that propose a domain for untagged objects. When it
  lands, proposals stay *proposals*: rendered in the untagged bucket in
  the candidate domain's colour at reduced opacity, with accept and
  dismiss. Nothing is ever tagged without a person saying so, because a
  wrong tag that appears by itself is worse than no tag.
- **The stale-tag report** in the manager (see above).
- **Manual domain reordering.**

## Open questions

- Should the gripes panel group and filter by domain? The mapping is
  free once tags exist — a finding's target is an object — and
  "aggregation has eleven blockers" is a more useful sentence than a
  flat list. Deferred so it does not widen Phase 11.
- Nesting, if the flat list turns out to be genuinely insufficient in
  practice: `parent_id` plus a path-shaped export, with the colour rail
  rules re-decided rather than inherited.
- Whether tags should follow a rename. The catalog has no rename event,
  so `ALTER TABLE … RENAME` currently reads as one stale tag plus one
  untagged object. Detecting it would mean tagging by oid, which is not
  portable across engines.
- Whether the untagged count belongs in the status bar. It is the number
  most likely to be acted on, and the status bar already carries the
  gripe count.
- Multi-tag, if a table honestly belongs to two domains. It costs the
  colour rail its meaning, so it needs a different visual answer first.
