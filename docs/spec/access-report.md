# Spec — Access report

**Status:** draft
**Phase:** 13
**Supersedes:** nothing (extends `docs/spec/object-view.md` "grants",
`docs/spec/gripes.md`, `docs/spec/domains.md`)

## Goal

Answer one question for a whole datasource at once: **what can each role
actually do?** Not what was granted — what is reachable, once `PUBLIC`,
role inheritance, ownership, schema `USAGE`, `SECURITY DEFINER` and view
ownership have all been resolved.

The question is urgent for PostgREST deployments, where the database's
grant graph *is* the API surface. A function nobody remembers writing is
an endpoint; a table with `SELECT` to `anon` and no row-level security
is a public data dump. There is no application tier in between to catch
it.

## The gap this closes

DataGripe's object-view grants tab and the hand-written
`permissions_matrix.sh` scripts it replaces both read
`information_schema.role_table_grants`. That view lists **direct grants
only**, and it is worse than incomplete:

- A `GRANT … TO PUBLIC` appears once, as grantee `PUBLIC`. Scan the
  column for `anon` and you see nothing, while `anon` has the privilege.
- A grant to a role that `anon` is a member of appears against the
  parent role's name. Same blind spot.
- The owner's implicit privileges never appear at all, because an ACL of
  `NULL` means "defaults apply", not "no access".
- It is filtered to *currently enabled roles*, so what it shows depends
  on who DataGripe connected as.

And the functions half of the problem is worse than the tables half:
**PostgreSQL grants `EXECUTE` on every new function to `PUBLIC` by
default.** A `proacl` of `NULL` is not "no grants", it is "owner has
everything and so does everybody else". Under PostgREST that means every
function you create is callable by `anon` from the internet until
somebody remembers to `REVOKE EXECUTE … FROM PUBLIC`. A report built on
direct grants shows that function's row as empty.

A report you consult before adding a role has to be right about this or
it is worse than no report, because it will be believed.

## Non-goals

- Not grant editing. The report reads; `GRANT`/`REVOKE` stay in the
  editor. (Emitting the statements to fix a finding is on the list —
  see "Open questions".)
- Not a PostgREST configuration reader. DataGripe does not parse
  `postgrest.conf` or query `pgrst` settings; the roles that matter are
  named by the user, once, per datasource.
- Not RLS policy authoring or simulation. The report shows that a policy
  exists and what its expression is; it does not evaluate it against a
  hypothetical row.
- PostgreSQL only in the first phase. MySQL grants are a different model
  and SQLite has none; both report the tab unsupported, the way every
  other engine-specific surface already does.

## Design

### Effective, direct, and why they differ

Every cell in the matrix carries two facts: what a role can do, and
where that came from.

| Source | Computed from |
| --- | --- |
| Effective | `has_table_privilege(role, oid, priv)`, `has_function_privilege`, `has_schema_privilege`, `has_column_privilege` |
| Direct | The object's ACL — `relacl`, `proacl`, `nspacl` — with the role named explicitly |
| via PUBLIC | The ACL has a `PUBLIC` entry (`=` with no grantee) for the privilege |
| via role | `pg_has_role(role, grantee, 'USAGE')` for some ACL grantee, with the membership chain named |
| owner | The role owns the object and the ACL is silent |
| superuser | `rolsuper`, or the privilege is unconditional |

The `has_*_privilege` family is the authority: it resolves `PUBLIC`,
inheritance and superuser in the server, which is the only place that
logic is correct. The ACL parse exists to *explain* the answer, never to
produce it. Where the two disagree, effective wins and the difference is
the interesting part of the report.

A cell is rendered as its effective privilege letters, with a marker
when nothing direct accounts for it:

```
| Object                | admin | manager | client | anon  | RLS |
|-----------------------|-------|---------|--------|-------|-----|
| public.agg            | RCUD  | R       | R      | –     | yes |
| public.casinos        | RCUD  | R       | R      | R°    | no  |
| public.login(text,…)  | X     | X       | X      | X°    | –   |

°  reachable without a direct grant — hover for the path
```

Hovering or focusing a `°` cell names the path: `via PUBLIC`,
`via member of authenticated`, `owner`. That string is the whole
product. "anon can read this" is a fact; "anon can read this because
somebody granted it to PUBLIC three years ago" is an action.

### Schema USAGE gates everything

A privilege on a table the role cannot reach is not access. The matrix
carries a `USAGE` row per schema at the top of that schema's group, and
a cell whose schema `USAGE` is missing renders its letters struck
through with the effective answer of "no". Reporting `R` for a table in
a schema the role cannot enter is the single easiest way to make a
security report wrong in the reassuring direction — so it is inverted
here: the report never claims access the role does not have, and never
hides access it does.

### What else the matrix carries

Beside the privilege columns, per relation:

- **RLS** — `relrowsecurity` / `relforcerowsecurity` as `no`, `yes`, or
  `forced`, plus the policy count.
- **RLS enabled, zero policies** is called out explicitly. It denies
  every row to every non-owner, which is usually not what was intended
  and which fails as an empty result set rather than as an error.
- **View execution** — a view without `security_invoker=true` runs as
  its owner, so it reads base tables with the owner's privileges and
  the owner's RLS exemptions. A view granted to `anon` over a table
  `anon` cannot read is a deliberate pattern *and* a common accident;
  the report marks it and lets a person decide which.
- **`SECURITY DEFINER`** — routines are marked, together with whether
  `proconfig` pins a `search_path`. The gripes engine already complains
  about the unpinned case per object (`definer-no-search-path`); the
  report is where you see all of them at once.
- **Column grants** — a relation with column-level ACLs shows a `col`
  marker, because an object-level cell necessarily rounds them off.
  Expanding the row shows the per-column matrix.

### Default privileges

`ALTER DEFAULT PRIVILEGES` decides what the *next* object gets, which is
the difference between an audit you do once and an audit you do forever.
A separate panel lists `pg_default_acl` entries as
"future tables created by `api` in `public` → `SELECT` to `anon`". An
entry that grants anything to a role marked untrusted is a finding in
its own right, before any object exists to point at.

### Which roles are columns

The role set is per datasource, chosen once and stored, because
DataGripe cannot know which of forty roles matter.

- Candidates are `pg_roles` minus `pg_%` system roles. The picker shows
  each with `LOGIN`, `SUPERUSER`, `BYPASSRLS`, `NOINHERIT` and its
  memberships, since all five change how a cell should be read.
- A role may be marked **untrusted** — the PostgREST anonymous role.
  Roles named `anon`, `web_anon`, `anonymous` or `unauthenticated` are
  *suggested*, never assumed: guessing wrong either floods the report
  with findings or silences the one role that mattered.
- A role may be marked **authenticator**. When one is, the report adds
  every role that role can `SET ROLE` to, transitively via
  `pg_auth_members`, because under PostgREST those are exactly the
  identities a request can arrive as. This set is shown as a small graph
  above the matrix — for most people it is the first time they have seen
  it drawn.
- `rolsuper` roles render their whole row as `all` in Ink dim rather
  than as letters. A superuser column of solid `RCUD` teaches the eye to
  ignore solid rows, which is the opposite of what the report is for.

Stored in `datasource_roles` (migration 0011) keyed by
`(workspace_id, connection_ref, role_name)` with the two flags and a
`shown` boolean.

### Findings, not opinions in the margin

The report's judgements are gripes, not a second parallel notion of
"warning" (`docs/spec/gripes.md`, "Findings are analysis; wording is
presentation"). They run in the existing engine, key off the object, get
dismissed at occurrence / target / project scope like everything else,
and appear in the gripes panel as well as inline in the report.

Proposed rule ids — the wording, as always, is the brand pass's:

| Rule id | Fires when |
| --- | --- |
| `grant.public-execute` | A routine is executable by `PUBLIC`, in a schema an untrusted role has `USAGE` on |
| `grant.definer-public-reach` | `SECURITY DEFINER` **and** reachable by an untrusted role — the escalation pair, and strictly worse than either alone |
| `grant.untrusted-write` | An untrusted role has `INSERT`, `UPDATE` or `DELETE` on a relation |
| `grant.untrusted-read-no-rls` | An untrusted role can `SELECT` a table with RLS off |
| `grant.rls-no-policy` | RLS on, zero policies — denies everything, silently |
| `grant.view-owner-bypass` | A view without `security_invoker` is readable by a role that cannot read its base relation |
| `grant.default-privileges-untrusted` | A `pg_default_acl` entry grants to an untrusted role |
| `grant.public-schema-usage` | An untrusted role has `USAGE` on a schema holding objects it has no business reaching |

`grant.public-execute` deserves the loudest severity the catalogue
allows, because it is the *default state* of a new function rather than
something anybody chose. Every other rule here describes a decision
somebody made; this one describes a decision nobody made.

Each rule needs its "looks like the finding and is not" fixture, per the
gripes testing rule: a function deliberately granted to `PUBLIC` and
marked as such, a table with RLS off that no untrusted role can reach, a
`SECURITY DEFINER` routine with a pinned `search_path` and no untrusted
grant.

### Where it lives

A dock tab, `access: <datasource>`, opened from the sidebar breadcrumb
header's overflow or from the sync tab. Not a modal: it is a document
you read, scroll, filter and keep open beside a query while you fix
things.

- **Filter by domain.** With domains tagged (`docs/spec/domains.md`) the
  report groups by domain, so "what can `anon` reach in `auth`" is one
  click. Untagged objects group last, as everywhere else.
- Filter by role, by schema, and a "differences only" toggle that hides
  every row where nothing is reachable without a direct grant. On a
  mature database that toggle is the report.
- Sorting is stable and the default order is `(schema, name)`, matching
  the export.

### One query, bounded

The whole matrix is one read-only query in one transaction with a
statement timeout, like `object.describe`. It is a cross join of
candidate objects against selected roles against privilege types, which
is cheap per cell and countable in advance: the request refuses above
`ACCESS_REPORT_MAX_CELLS` (default 250,000) and asks for a schema or
domain filter rather than sitting there. The count is shown before the
run when it is close.

`access.report` is a `viewer`-role WebSocket action — reading who can do
what is not a mutation, and hiding it from viewers would mean the people
most likely to notice a mistake cannot look.

### Export

The report is part of the domain dump, replacing the two markdown files
`permissions_matrix.sh` produces:

```
<domain root>/
  access/
    matrix.md          # roles × objects, effective, with ° markers
    rls-policies.md    # every policy, expression included
    default-acl.md     # ALTER DEFAULT PRIVILEGES entries
    findings.md        # the gripes above, current at export time
```

Written under the same determinism rules as everything else
(`docs/spec/domains.md`, "Determinism is the requirement") — which
specifically means **no `Generated: <date>` line in the body**. The
existing scripts write one, so every run dirties both files and the diff
that would have told you `anon` gained `UPDATE` last Tuesday is buried
under a date change. The timestamp belongs in the run history and in
`pull.log`, not in the artifact being diffed.

`findings.md` is the one people will read in review, so it is ordered by
severity then object, and it names dismissed findings in a separate
trailing section rather than omitting them. A dismissal is a decision
the repository should record.

### Grants in the per-object DDL

Related, and specified here because it is the same catalog read: the
per-object `.sql` files in the domain export carry their grants
(`docs/spec/domains.md`, "Export"). A `CREATE FUNCTION` with no grant
block does not tell a reviewer whether the function is public, and under
PostgREST that is the only thing they needed to know.

- Emitted as canonical `GRANT <privs> ON <kind> <object> TO <grantee>;`
  lines, sorted by `(grantee, privilege)`.
- **Grants to `PUBLIC` are emitted explicitly**, including the implicit
  default `EXECUTE` on routines. Writing out
  `GRANT EXECUTE ON FUNCTION public.login(text, text) TO PUBLIC;` when
  nobody typed it is the point: the default becomes visible, and it
  shows up in the diff the day a new function is added.
- When there is genuinely nothing beyond the owner, the file says so in
  a comment. Absence and silence are different, per the object view's
  "Three kinds of nothing".

## Testing

- A table granted only to `PUBLIC`: every non-superuser role's cell
  reports effective access with a `via PUBLIC` path, and the naive
  `role_table_grants` query the current tab uses is asserted to *miss*
  it — the regression test for this whole spec.
- A function with `proacl IS NULL`: `anon` shows `X`, `via PUBLIC`,
  and `grant.public-execute` fires.
- `REVOKE EXECUTE … FROM PUBLIC` on that function: the cell empties and
  the finding clears.
- A role inheriting through two levels of membership: the path names
  both hops, in order.
- `NOINHERIT` membership: no effective privilege, and the report does
  not claim one. (This is the case a hand-written `pg_has_role` query
  usually gets wrong in the unsafe direction.)
- Schema `USAGE` revoked: table cells strike through and report no
  access, and no finding fires for an unreachable object.
- A view over a table the grantee cannot read, with and without
  `security_invoker=true`: `grant.view-owner-bypass` fires only for the
  first.
- RLS enabled with zero policies is distinguished from RLS disabled.
- Column-level grants: the object cell shows `col` and the expanded row
  matches `has_column_privilege` per column.
- Export determinism: two consecutive exports of `access/` are
  byte-identical, and no file contains a date.
- Cell cap: a request over the cap is refused with the count and a named
  error, not truncated.

## Open questions

- Should the report emit the `REVOKE`/`GRANT` statements that fix a
  finding? It is a small step from knowing to a reviewed script, and it
  reuses the `object.alter` dry-run shape exactly. It is also the first
  time DataGripe would propose a security change, which deserves its own
  decision rather than arriving as a convenience.
- Diffing two reports — "what changed since last Tuesday's export" — is
  the question people actually ask. Today `git diff` on `matrix.md`
  answers it, which may be enough, and is an argument for keeping the
  markdown human-first.
- MySQL. The model is different enough (`mysql.user`, `mysql.db`,
  host-qualified grantees, no roles before 8.0) that it is a separate
  design rather than a port.
- Whether the anonymous-role marking should be inferable from a
  PostgREST `pre-request`/`db-anon-role` setting when one is discoverable
  in `pg_settings`. It would remove the one manual step, at the cost of
  a wrong guess being invisible.
