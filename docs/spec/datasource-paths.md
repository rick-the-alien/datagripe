# Spec — Datasource paths

**Status:** current
**Phase:** 12
**Supersedes:** nothing (extends `docs/spec/connections.md`,
`docs/spec/editor-workspace.md`, `docs/spec/multiplayer.md`; shares the
host-filesystem gate with `docs/spec/domains.md`)

## Goal

A database does not arrive out of nowhere. Somewhere there is a
checkout: the migrations that built it, the queries the team keeps, the
domain dump the sync tab writes. Today DataGripe can see the database
and cannot see any of that, so the file you want is in an editor in the
other window and the query you paste in here is a copy that drifts.

A **datasource path** is a `(name, directory)` pair configured on a
datasource. While that datasource is the active one, each pair gets its
own section in the left bar, above the workspace files, titled with the
name. Inside it is a file tree; clicking a file opens it in the editor.

The point is that it is *the file* — not an import of it. Opening one
caches it as a workspace document so it gets the live multiplayer state
every shared file has, and every save writes the bytes back to the path
they came from. Work persists with the project, in the right location.

## Non-goals

- Not a file manager. No create, rename, move or delete: the tree reads
  a directory and opens files out of it. Anything structural belongs to
  the tool that owns the checkout.
- Not a general text editor. It is a SQL editor, so files over 2 MB and
  files with NUL bytes are refused rather than loaded and mangled on the
  next save.
- Not per user. Paths are workspace-local configuration about a
  datasource, so everybody in the project sees the same sections —
  everybody is looking at the same server's disk. The exception is a git
  datasource, whose repository defines them and whose rows here are a
  mirror of that file (`docs/spec/git-datasources.md`).
- Not a watcher. Nothing polls the filesystem; a change on disk is
  noticed the next time the file is opened (see "When the file moves
  underneath").
- Not a git client. `docs/spec/domains.md` "Committing" and
  `docs/spec/git-datasources.md` own the places DataGripe runs git.

## Where they live

`datasource_paths`, keyed by `(workspace_id, connection_ref)` and
ordered by `position` (migration 0013). A table rather than a column on
`connections`, for the same reason `datasource_export_paths` is one
(migration 0012): a predefined connection has no row there, and it must
be able to carry paths too. The path is not part of the datasource — it
is what this project does with it, which is also why a predefined
datasource stays read-only everywhere else on its page and still saves
these.

They ride on `ConnectionMetadata.paths`, so the sidebar has them the
moment the connection list loads and needs no second round trip.

## Configuring them

On the datasource edit page, in a `paths` section below `domain export`.
Rows of name + directory, add and remove, and a per-row **check** that
asks the server whether it can actually reach the directory.

Saved by `datasource.set-paths` rather than `connection.update` — same
reason as the export path — but on the form's single save, not a button
of its own. A form with two save buttons makes someone press both
(`docs/brand/mocks/datasource-settings.html` "The two save buttons").

`datasource.set-paths` replaces the whole list:

- A row the request keeps is **updated in place**, so a renamed section
  keeps its id, and with it every file already open from it. The origin
  of a file-backed document is keyed by path id; a rename that reissued
  ids would orphan every open tab.
- A row the request drops **archives** the documents opened from it
  rather than deleting them. Removing a pair is a sidebar decision and
  must not be able to destroy a member's unsaved work. Nothing on disk
  is touched either way.
- An id belonging to a different datasource is refused, so a path id is
  not a workspace-wide handle that the connection ref merely decorates.
- Two rows with the same name are refused: the sidebar could not tell
  the sections apart.

## What it may read

Every host-filesystem path goes through one gate, shared with the domain
export (`apps/server/src/domains/paths.ts`):

- `HOST_FS_DISABLED` turns export *and* datasource paths off outright.
  This is what a hosted, multi-tenant deployment sets — there, the
  person clicking the tree does not own the disk.
- `HOST_FS_ROOTS` is an **optional** colon-separated allowlist. Empty —
  the default — means no allowlist: the directory is already named
  explicitly per datasource, and making people configure the same thing
  twice bought nothing. Set it when the host is shared.
  `DOMAIN_EXPORT_ROOTS` is the pre-rename name and is still honoured.
- The configured directory must be **absolute**. With no allowlist a
  relative path would quietly resolve against the server's working
  directory.
- It is resolved with `realpath` on every request, not once at
  configuration time, so a symlink swapped in afterwards is caught.

Inside a resolved root, the rules are deliberately *not* the export's
`safeJoin`. That one guards generated components against a hostile
database and allows only `[A-Za-z0-9._-]`; these are names that already
exist on the user's own disk, where `0001 init (v2).sql` is an ordinary
filename. What is checked instead is the only thing that matters for a
path the browser supplied:

- the joined path is lexically inside the root — this rejects `../`
  without touching the disk;
- and the `realpath` of the result is still inside it, so a symlink
  inside the root pointing at `/etc` is refused rather than followed.

Listings are capped at 2,000 entries per directory (a `node_modules` the
sidebar could not render anyway) and load one directory at a time, on
expand. Walking a checkout on open would stall the sidebar for the one
file you actually wanted.

Reading a file is `viewer`; opening one is `editor`, because opening
caches it as a workspace document and saving writes to disk.

## The file as a document

`file.open` returns a normal `Document` row that additionally carries an
`origin`: `(connectionRef, pathId, filePath)`. That is the whole trick —
everything downstream already works. Presence, followed cursors,
revision-guarded saves and the conflict banner are the shared-file
machinery from `docs/spec/multiplayer.md`, untouched.

- **One live document per file.** A partial unique index on
  `(workspace_id, origin_path_id, origin_file_path)` where the document
  is not archived. Two people opening the same file at the same moment
  land on one row; two caches of one file would mean two people editing
  two copies with the last save winning silently.
- **The row is the cache, the file is the artifact.** `document.save`
  writes the database row and then the file. In that order, so a refused
  write leaves the row and the disk both readable rather than the row
  silently ahead.
- **The path is re-resolved on every write**, never remembered from when
  the file was opened. The pair can be repointed, removed, or have a
  symlink swapped underneath it while a tab sits open, and none of those
  may turn into a write somewhere else.
- File-backed documents are excluded from the *Workspace files* section:
  they belong to their path's section, and one file in two lists with
  two different names for what it is helps nobody.

The language *was* `sql` for every document, so a `.md` opened out of a
path got SQL highlighting — a wart this spec named and Phase 14 fixed.
`documents.language` now follows the file's extension, and a markdown
file opens rendered with its `sql` fences runnable in place
(`docs/spec/markdown-documents.md`).

## When the file moves underneath

`disk_content_hash` records the bytes DataGripe last read from or wrote
to the file. On `file.open` there are three cases:

1. **Disk matches the recorded hash.** Nothing moved; return the cached
   document.
2. **Disk moved, and the cached content still equals the recorded
   hash.** Only the file changed, so the file wins: its content is
   adopted as a new revision and broadcast. This is the `git pull` case,
   and asking about it would be noise.
3. **Both moved.** Neither can be adopted silently, so both are held.
   The editor shows a banner with the two options, and either answer is
   a *save* — the one action that makes the row, the file and every
   other viewer agree again.

Nothing watches the filesystem. A file that changes while a tab is open
is noticed on the next open, not live; a watcher across every configured
root is a different feature with a different cost.

## What the sidebar shows

```
┌ migrations ─────────────────┐   ← the pair's name is the box title
│ ▾ 2026                      │
│   · 0007_domains.sql        │
│   · 0008_paths.sql        ● │   ← dirty, same dot as the tab
│ · README.md                 │
├ queries ────────────────────┤   ← a second pair, its own section
│ · churn.sql                 │
├ Workspace files ────────────┤
│ · shared.sql                │
├ Scratchpads (local) ────────┤
└─────────────────────────────┘
```

Path sections come first because they are the project's own files; the
workspace files below them are DataGripe's. They are ordinary
`SidebarSections`, so they collapse and dock like the rest, and
switching datasource swaps them the way it swaps the tree.

A directory that will not read shows why, plus the absolute path it
tried — "not readable" on its own sends people to the wrong machine.
