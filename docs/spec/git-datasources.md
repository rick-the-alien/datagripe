# Spec — Git datasources

**Status:** draft
**Phase:** 14
**Supersedes:** the `manifest.json` half of `docs/spec/domains.md`
"The manifest" (extends `docs/spec/connection-sources.md`,
`docs/spec/datasource-paths.md`, `docs/spec/domains.md`; shares the
host-filesystem gate with both)

## Goal

`docs/spec/datasource-paths.md` got DataGripe as far as *seeing* the
checkout: you name a directory, it becomes a sidebar section, files open
and save back. What it cannot do is say where that checkout came from,
and it cannot carry its own configuration — the pairs live in a table in
somebody's workspace, so the second person on the team sets them up
again by hand, from memory, slightly differently.

A **git datasource** inverts that. The repository is the definition. It
carries a `.datagripe/` directory describing the connection, the
directories worth showing, and the domain tagging; DataGripe reads it,
and a teammate who clones the repo gets the same datasource, the same
sidebar sections and the same domains without configuring anything.

The corollary is that DataGripe now has to be honest about git. It runs
the system `git` binary with your ambient configuration
(`docs/spec/domains.md` "Committing" already establishes this and the
rules do not change), and it runs it **only when you press something**.
Editing a file does not commit it. Saving does not push. The left bar
gets a section that tells you what has changed and gives you the three
buttons; nothing behind it happens on a timer.

## Non-goals

- **Not a git client.** Status, commit, push, pull, fetch. No branch
  management, no merge conflict resolution, no rebase, no stash, no
  history browser, no blame. When git needs a decision DataGripe cannot
  represent, it stops and shows you git's own stderr, and you go to a
  terminal.
- **Nothing automatic.** No autocommit, no autopush, no pull on open,
  no background fetch. Every invocation is a press. This is the single
  most important sentence in this spec.
- **No credential management.** Unchanged from `docs/spec/domains.md`:
  `GIT_TERMINAL_PROMPT=0`, an askpass that fails immediately, and
  `HOME`/`PATH`/`SSH_AUTH_SOCK` passed through because that is where
  working credentials live. A push with no credentials fails with git's
  message, verbatim.
- **Not a secret store for the repo.** `.datagripe/config.yaml` is
  committed. It names an environment variable; it never contains a
  password.
- **Not multi-repo per datasource.** One datasource, one work tree. Two
  repositories are two datasources.
- **Not a submodule-aware anything.** A submodule is a directory to the
  file tree and invisible to the status list.

## Definitions

| Term | Meaning |
| --- | --- |
| Git datasource | A datasource whose definition is read from a repository's `.datagripe/` directory |
| Work tree | The repository root, as `git rev-parse --show-toplevel` reports it |
| Clone | DataGripe created the checkout, from a URL, under the repos home |
| Adopted | The user pointed at an existing checkout DataGripe did not create |
| Sync dir | The directory inside the repo the domain export writes into |

A git datasource implements the same `ConnectionMetadata` contract as a
managed or predefined one, so the explorer, editor and execution paths
never branch on origin — the third value of `source` is the only
difference they can see.

## Design

### The `.datagripe` directory

At the work tree root, committed, hand-editable:

```
.datagripe/
  config.yaml     connection identity, fields, branding, paths
  sync.yaml       where the domain export writes, and how   (optional)
  domains.yaml    domains, colours and tagged objects        (generated)
```

Three files rather than one, and the split is by feature rather than by
size. A config that is "really just connection info and branding" stays
readable in a diff and stays stable; a domain dump churns every time
somebody tags a table, and burying the connection under three hundred
lines of object list means every tagging change shows up as a change to
the file that defines the database. New features get new files here
rather than new top-level keys in `config.yaml`.

Unknown top-level keys are **preserved on write and ignored on read**,
so an older DataGripe does not silently delete a newer one's settings
when it rewrites the file. Unknown keys inside a block DataGripe owns
are an error, because that is almost always a typo.

Every file starts with `version: 1`. A file with a version DataGripe
does not know refuses the whole datasource rather than reading the parts
it recognises — a half-understood connection definition points at the
wrong database.

#### `config.yaml`

```yaml
version: 1

datasource:
  name: wallet-prod
  adapter: postgres
  host: db.internal
  port: 5432
  database: wallet
  username: reader
  passwordEnv: WALLET_PG_PASSWORD
  tlsMode: verify-full
  readOnly: true
  showAllSchemas: false

branding:
  # Optional. Colours the datasource breadcrumb and the tab accents so
  # prod does not look like staging. One of the eight palette slots
  # domains already use (docs/spec/domains.md "The colour rail").
  colour: 3
  # Free text under the name in the datasource selector.
  description: Production wallet database. Read-only credentials.

paths:
  - name: Some Folder
    path: foo
  - name: bar
    path: bar
```

- `datasource` is `predefinedConnectionSchema` minus `id` and
  `workspaces`, which are meaningless here: the repository *is* the
  identity, and visibility is whoever can see the checkout.
- `paths` is the same `(name, directory)` pair as
  `docs/spec/datasource-paths.md`, with one difference that matters:
  **the path is relative to the work tree root**. `foo` and `./foo` are
  the same directory. An absolute path is refused, and so is any path
  that climbs out of the root — checked lexically and again with
  `realpath`, by the same `resolveInside` the file tree already uses.
  A repository that could name `/etc` in a committed file would be a
  remote code path with extra steps.
- Two paths with the same `name` are refused for the reason they are
  refused in the form: the sidebar could not tell the sections apart.

#### `sync.yaml`

Optional. Absent means this datasource has no export target configured
yet, which is a normal state — the button on the sync tab writes this
file when you pick one.

```yaml
version: 1
sync:
  # Relative to the work tree root, like every path in this directory.
  dir: domains
  includeAccessReports: true
  maxDataRows: 10000
```

`sync.dir` replaces `datasource_export_paths` for a git datasource. It
is deliberately *not* in `config.yaml`, even though the first sketch of
this feature put it there: it is the one setting here that a second
person might reasonably want set differently, and it belongs with the
feature that reads it.

#### `domains.yaml`

Generated by the export and read by the import. It **replaces
`manifest.json`** (`docs/spec/domains.md` "The manifest") for every
datasource, not only git ones — one serialisation format for the
`.datagripe` directory is worth more than backwards compatibility with a
file that has existed for one phase.

```yaml
version: 1
connection:
  ref: git:9b1f…
  name: wallet-prod
  engine: postgres
domains:
  - name: auth
    colour: 1
    description: ""
    includeData: false
    objects:
      - schema: basic_auth
        kind: table
        name: users
      - schema: public
        kind: function
        name: login(text, text)
```

The determinism rules from `docs/spec/domains.md` carry over unchanged
and gain one: **YAML is emitted with a fixed serialiser configuration**
— block style, two-space indent, no line folding, no anchors or
aliases, keys in the order above rather than alphabetically, and one
trailing newline. Line folding is the trap. A description that grows by
one character must not reflow a paragraph and put a twelve-line diff in
front of somebody.

`manifest.json` is not read as a fallback. An existing dump is
re-exported once, which produces `domains.yaml` and deletes
`manifest.json` in the same run — a prune, which the export already
does for files it no longer generates.

### Adding one

Two ways, one form, both ending in the same place:

- **Clone.** Paste an `https://` or `ssh://`/`scp`-style git URL.
  DataGripe runs `git clone` into the repos home (below) and reads
  `.datagripe/config.yaml` out of the result.
- **Adopt.** Give an absolute path to a checkout that already exists.
  `git rev-parse --show-toplevel` must succeed and must report a root
  that contains the path given, and the path given must be the root
  itself — adopting `~/repo/src` and then writing `~/repo/.datagripe`
  would be a surprise.

Either way the repository must contain `.datagripe/config.yaml`. A
directory that does not is refused with the path it looked in, rather
than being adopted as an empty datasource nobody can use.

A clone URL is validated by the same SSRF policy as a connection host
(`apps/server/src/security/ssrf.ts`), because it is the same thing: a
user-supplied name the server is about to connect to. `file://` and
local-path remotes are refused outright — a clone from `/etc` is not a
feature.

#### Where clones live

`GIT_REPOS_DIR`, defaulting to `repos/` beside the embedded data
directory — `./data/repos` in the repo checkout, and
`<OS app-data>/repos` under the desktop shell, which is what
`apps/desktop/src/main.ts` already does for `pg/`. One directory per
datasource, named `<slug>-<first 8 of the datasource id>`, so two
repositories called `datasource` do not collide and the directory name
is still readable.

DataGripe may delete a directory it created, and only one it created —
that is what `managed_clone` records. Removing an adopted datasource
removes the row and touches nothing on disk.

#### Secrets

The repository names an environment variable; the server resolves it.
This is `passwordEnv` from `docs/spec/connection-sources.md`, and it is
the documented path.

When the variable is not set, the datasource is **listed and not
connectable**, with the variable's name in the message. It is not hidden
and it is not an error at load: the person who clones the repo on a
laptop where `WALLET_PG_PASSWORD` is not exported should see the
datasource and be told exactly which variable to set, not wonder why the
sidebar is empty.

As an escape hatch, the password may be supplied in DataGripe once and
stored encrypted at rest with the existing keyring
(`apps/server/src/crypto/keyring.ts`), keyed to `(workspace, datasource
id)`. It never goes near the repository. An inline `password:` in
`config.yaml` is **refused**, not deprecated: `connections.json` can get
away with "development only" because it is gitignored, and this file is
the opposite of gitignored.

### What the repo owns and what the workspace still owns

| | Source |
| --- | --- |
| name, adapter, host, port, database, username, tls, readOnly, showAllSchemas | `config.yaml` |
| branding colour and description | `config.yaml` |
| path pairs | `config.yaml` |
| sync dir and export options | `sync.yaml` |
| domains and tags | the app database; `domains.yaml` on export/import |
| password | `passwordEnv`, or the local keyring |
| default connection for a document, layout, drafts | the workspace, as before |

On the datasource edit page a git datasource renders like a predefined
one — read-only, with "Defined by `.datagripe/config.yaml`" and a button
that opens that file in the editor. Editing the file and saving it is
how you change the datasource, which is the whole point; the connection
list reloads when a `.datagripe/` file is saved or a pull changes one.

Note the reversal against `docs/spec/datasource-paths.md`: there, paths
were workspace-local configuration *about* a datasource, precisely so a
read-only predefined connection could carry them. Here the datasource
brings its own, and `datasource_paths` rows are ignored for a git
datasource rather than merged. Merging would mean the sidebar showed
sections a teammate did not have, from a file that claims to define the
sidebar.

### Exporting a config from an existing datasource

On the edit page of any managed or predefined datasource, **export
config**. It generates the `.datagripe/` file set from what the
datasource already has — connection fields, its `domainExportPath` as
`sync.dir` when that path is inside the target repo, its
`datasource_paths` relativised against the target repo, and its domains
as `domains.yaml` — and writes it into a directory you name.

- **The password is never written.** The generated `config.yaml` carries
  `passwordEnv: <NAME>` with a name derived from the datasource
  (`WALLET_PROD_PASSWORD`), which you are told about in the panel above
  the button, because a placeholder that looks like a setting is worse
  than a missing one.
- A path that does not sit inside the target repository is written as a
  comment with the absolute path and a note, not as a broken relative
  path. Silently dropping it is how a teammate ends up with three of
  your four sections.
- The generated YAML is shown before it is written, with copy-to-
  clipboard, because half the time the destination is a repository on a
  different machine.
- Writing over an existing `.datagripe/config.yaml` asks first and shows
  what differs.

Exporting a config does not convert the datasource. It stays managed or
predefined; you get a directory you can commit, and adding it back as a
git datasource is a separate, deliberate act.

### The repository section

A new left-bar section, present only while a git datasource is the
active one, above its path sections
(`docs/spec/datasource-paths.md` "What the sidebar shows"):

```
┌ repository ─────────────────┐
│ main · ↑2 ↓0                │   ← branch, ahead/behind upstream
│ ☑ M foo/blah.sql            │   ← staged for the next commit
│ ☑ M .datagripe/config.yaml  │
│ ☐ ? bar/baz/query22.sql     │
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│ [ commit… ] [ push ] [ pull ]│
│ [ refresh ]                  │
├ Some Folder ────────────────┤
│ ▾ foo                       │
```

- **The list is `git status --porcelain -uall` at the work tree root**,
  not scoped to a sub-path. This is a repository view, and hiding a
  changed file because it is outside a configured path is how you commit
  half of something.
- **Every file is a checkbox and nothing is checked by default.** The
  commit stages exactly what you ticked — `git add -- <paths>` with the
  selected pathspecs and no `-A` anywhere — then `commit -m`. The rule
  from `docs/spec/domains.md` survives in the form that matters: a
  commit from DataGripe never stages a file the person did not name.
  Files already staged when the section loaded show as checked and stay
  checked; unticking one runs `git restore --staged`.
- **`commit…` opens a message field.** It is a press, then a second
  press. `push` is separate and always separate, because it is the only
  button here that leaves the machine.
- **`pull` is `git pull --ff-only`.** Anything that would need a merge
  commit, a rebase, or a conflict resolution refuses with git's own
  message. DataGripe cannot represent a conflicted work tree and must
  not pretend to.
- A row's status letters are git's, unexplained and unabbreviated:
  ` M`, `M `, `??`, `A `, `D `, `R `, `UU`. People who use git read
  these already, and people who do not are not served by a paraphrase.
- Clicking a row opens the file, when it is one the editor can open.
- **`refresh` is the only way the list updates**, plus after any
  operation this section ran. Nothing polls. A status call per second
  across every open workspace is a `git` process per second.

The section is capped at 500 rows; past that it shows the count and a
line saying to use a terminal, because a 12,000-file status is not a
list anybody is going to tick through.

### After a pull

A successful pull can change files that are open in tabs. The machinery
for this already exists — `disk_content_hash` and the three cases in
`docs/spec/datasource-paths.md` "When the file moves underneath" — and
this is exactly the `git pull` case that spec names.

What changes: the server broadcasts `repo.changed` with the datasource
ref after a pull that moved `HEAD`, and each client re-runs the open
check for every file-backed document it holds from that datasource.
Documents whose cached content still matches the recorded hash adopt the
new bytes silently. Documents with edits of their own raise the existing
banner. Directory listings for the datasource's paths are invalidated,
and a `.datagripe/` file that changed reloads the connection list.

A pull is refused while any file-backed document from that datasource is
dirty *and* would be touched by the pull. DataGripe knows the changed
file list from `git status`, and offering to fast-forward over somebody's
unsaved work is not a service.

### Storage

Migration 0014:

```sql
CREATE TABLE git_datasources (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
	-- Absolute path of the work tree root on the host the server runs on.
	repo_path text NOT NULL,
	-- The remote it was cloned from; NULL when an existing checkout was
	-- adopted. Not read back for anything except display: the remote of
	-- record is whatever `git remote` says now.
	remote_url text,
	-- True only when DataGripe created this directory, and therefore the
	-- only case in which it may delete it.
	managed_clone boolean NOT NULL DEFAULT false,
	created_by uuid REFERENCES users (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (workspace_id, repo_path)
);
```

A pointer, not a copy. Nothing from `config.yaml` is denormalised into
this table, because then there would be two answers to what the
datasource is and one of them would be stale. The file is read on
`workspace.open` and cached in memory with the file's mtime and size as
the cache key.

`ConnectionMetadata.id` for a git datasource is `git:<uuid>`, so nothing
branches on id shape: managed ids are bare UUIDs, predefined ids are
slugs, git ids carry their prefix. `connectionSourceSchema` gains
`"git"`.

Domains, tags, gripe dismissals, `datasource_roles` and query history all
key on `connection_ref` as text already and need no change.

### Actions (WebSocket)

| Action | Role | Notes |
| --- | --- | --- |
| `git.datasource.add` | `owner` | Clone or adopt; talks to a remote, writes the host |
| `git.datasource.remove` | `owner` | Deletes the checkout only when `managed_clone` |
| `git.datasource.reload` | `editor` | Re-read `.datagripe/`, bypassing the mtime cache |
| `git.status` | `editor` | Branch, upstream ahead/behind, porcelain rows |
| `git.stage` | `editor` | `add --` / `restore --staged` for named paths |
| `git.commit` | `editor` | Stages the named paths, then commits |
| `git.pull` | `editor` | `pull --ff-only` |
| `git.push` | `owner` | The only one that leaves the machine |
| `datasource.export-config` | `editor` | Generate, preview, write `.datagripe/` |

`commit` and `pull` being `editor` is a deliberate departure from
`docs/spec/domains.md`, where every git operation is `owner`. The reason
that rule exists is that `domain.git` writes a generated tree and pushes
it; an editor who may already open a file, edit it and write it back to
disk is not meaningfully more dangerous for being able to record that in
the local history. `push` and `add` stay `owner` because they reach the
network.

Every invocation keeps the guarantees from `docs/spec/domains.md`
"Committing" without restatement: `Bun.spawn` with an argv array and no
shell, a fixed verb list with no user-supplied flags, `--` before every
user-supplied value, `GIT_TERMINAL_PROMPT=0` with a failing askpass, a
`GIT_TIMEOUT_MS` kill, verbatim stdout/stderr with the exit code as the
verdict, and an audit line per call. `apps/server/src/domains/git.ts`
moves to `apps/server/src/git/` and grows the new verbs; the domain
export keeps its own root-scoped `add`.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GIT_ENABLED` | `false` | Gates every git feature, including git datasources. `DOMAIN_EXPORT_GIT` is the pre-rename name and is still honoured |
| `GIT_REPOS_DIR` | `<data dir>/repos` | Where clones go |
| `GIT_TIMEOUT_MS` | `60000` | Per invocation. `DOMAIN_GIT_TIMEOUT_MS` is the pre-rename name |
| `GIT_CLONE_TIMEOUT_MS` | `600000` | Clone separately, because a big repository is not a hung one |

`HOST_FS_DISABLED` turns git datasources off regardless, the same way it
turns the export and the path tree off: all three are the server reading
and writing a disk the person pressing the button may not own.

## Testing

- **Round trip.** Export a config from a managed datasource into a
  temporary repo, add that repo as a git datasource, assert the
  connection fields, the path pairs and the domains match the original,
  and that no password was written.
- **Determinism.** Export domains twice against a fixture database and
  assert the two `domains.yaml` files are byte-identical, including
  after a description is edited to a length that would tempt a folder.
- **Relative paths.** `foo`, `./foo` and `foo/` resolve to one
  directory; `/etc`, `../outside` and a symlink in the repo pointing at
  `/etc` are each refused with a named error and list nothing.
- **Config refusals.** Missing `.datagripe/config.yaml`, an unknown
  `version`, two paths with the same name, and an inline `password:`
  each refuse the datasource and say which file and which key.
- **Unknown keys.** A `config.yaml` with a top-level block DataGripe
  does not know survives a write from DataGripe unchanged.
- **Staging.** With five modified files, ticking two and committing
  produces a commit containing exactly those two and leaves the other
  three modified in the work tree.
- **Argv.** A commit message of `--amend`, and a filename beginning with
  `-`, both round-trip as values.
- **No credentials.** A push against a remote with no credentials
  surfaces git's stderr and a non-zero exit and does not hang until the
  timeout.
- **Pull refusal.** A dirty file-backed document whose file the pull
  would touch refuses the pull and names the file; a dirty document the
  pull would not touch does not.
- **Pull adoption.** A file changed only on disk is adopted silently as
  a new revision; a file changed on both sides raises the banner. Both
  are the existing `file.open` cases, asserted through a real pull.
- **Missing secret.** With `passwordEnv` naming an unset variable, the
  datasource is listed, the connection test fails, and the message names
  the variable.
- **Clone safety.** `file:///etc`, a bare local path, and a URL
  resolving to a private range with SSRF enabled are each refused before
  any process is spawned.
- **Adopted removal.** Removing an adopted datasource leaves the
  directory on disk; removing a cloned one deletes only its own
  directory under `GIT_REPOS_DIR`.

## What is not built

- **Branch switching.** The section shows the branch and will not change
  it. Checking out a branch with open dirty tabs is a whole design.
- **Conflict resolution.** `--ff-only` is the position, not a first
  step toward a merge UI.
- **Watching the work tree.** Consistent with
  `docs/spec/datasource-paths.md`: nothing polls, and `refresh` is a
  button. A watcher across every repository in every workspace is a
  different feature with a different cost.
- **Per-user overrides of a repo-defined datasource.** If the committed
  host is wrong for you, the answer today is a second datasource.
- **`.datagripe` in a subdirectory.** It is at the work tree root or it
  does not exist.

## Open questions

- Whether `branding.colour` here and the domain colour palette should be
  the same eight slots. Reusing them is cheap and might make a prod
  datasource look like a domain rail.
- Whether a git datasource should be able to carry *additional*
  workspace-local paths on top of the repo's, for the one person who
  keeps a scratch directory beside the checkout. Currently no, because
  merged lists make "what does this file define" unanswerable.
- Whether `sync.yaml` should be able to name more than one sync dir,
  once a repository holds two datasources. Two datasources in one
  repository is not supported and this is the first thing that would
  need to change if it were.
- Whether the commit list should offer hunk-level staging. Almost
  certainly not — that is the point where a terminal is better — but it
  is the most likely request.
- Whether `domains.yaml` should live in `.datagripe/` or beside the
  sync dir it describes. It is in `.datagripe/` because it is
  configuration that round-trips, not output; the counter-argument is
  that it is written by the export and prunes like output.
