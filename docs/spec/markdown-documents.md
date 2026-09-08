# Spec — Markdown documents

**Status:** current
**Phase:** 14
**Supersedes:** the "the language stays `sql`" paragraph in
`docs/spec/datasource-paths.md` "The file as a document" (extends
`docs/spec/editor-workspace.md`, `docs/spec/query-execution.md`,
`docs/spec/gripes.md`)

## Goal

`docs/spec/datasource-paths.md` shipped with a wart it named out loud: a
`.md` opened out of a datasource path gets SQL highlighting, "and the fix
is a language field on the document rather than anything here". This is
that fix, and the reason it is worth a spec rather than a one-line enum
change is what a `.md` file in a database repository actually contains.

It contains a runbook. `maintenance.md` explains what the nightly job
does, and then — in a fenced `sql` block — the query you run when it
fails. Today that query is read in one window and retyped in another,
which is how it drifts from the prose that explains it. DataGripe can
run it where it is written.

So: markdown is the second document language, decided by extension, in
every place DataGripe shows files. It **opens rendered**, because a
runbook is something you read. Its SQL blocks are executable in place,
against the document's connection, through exactly the execution path a
selection goes through. And a button in the bottom right flips to the
editor, where the fences get the SQL editor's completion, formatting and
gripes, and flips back.

## Non-goals

- **Not a markdown authoring tool.** No preview-beside-editor, no
  toolbar, no WYSIWYG, no paste-image. It is two modes and one button.
- **Not a general document store.** Markdown arrives because a file is
  called `.md`. There is no "new markdown document" verb beyond naming
  one — see "Where a language comes from".
- **Not HTML.** Raw HTML in markdown is escaped and rendered as text,
  never passed through. A file from a checkout is content somebody else
  may have written.
- **Not a third language.** JSON, YAML, TOML and the rest stay `sql` and
  keep the wart, deliberately: markdown earns a language because it has
  runnable content, and the others would be a syntax-highlighting
  project with no end.
- **Not a notebook.** Blocks do not share state, do not run in order,
  have no persisted outputs, and produce no artifact. Running one is
  running a query.

## Design

### Where a language comes from

One rule, everywhere: **the extension of the name decides.**

| Name | Language |
| --- | --- |
| `maintenance.md`, `README.markdown` | `markdown` |
| `blah.sql`, `query22.sql` | `sql` |
| `notes`, `analysis.json` | `sql` |

The rule applies to file-backed documents (`origin.filePath`), to shared
workspace files and to local scratchpads, because all three are named by
a person and all three show up in a files area. Renaming a document from
`notes.sql` to `notes.md` changes its language, which is the behaviour
somebody renaming it is asking for.

`documentSchema.language` becomes `z.enum(["sql", "markdown"])` and
migration 0015 adds `documents.language text NOT NULL DEFAULT 'sql'`
with a check constraint. It is stored rather than derived on read
because the client needs it before it has the content, and because a
title is editable while a language change mid-edit is not something the
editor should discover from a keystroke — the language is recomputed on
save, with the title, and broadcast like any other document change.

The default for `document.create` stays `sql`: a new scratchpad is a
scratchpad. Name it `notes.md` and it is markdown on the next save.

### Two modes

A markdown document's editor panel has a mode, `view` or `edit`, and
opens in `view`.

```
┌ maintenance.md ─────────────────────────────────────────┐
│                                                         │
│  Nightly reconciliation                                 │
│  ─────────────────────                                  │
│  When the job reports a gap, find the orphans:          │
│                                                         │
│  ┌───────────────────────────────────── sql ──── ▶ ──┐  │
│  │ select * from ledger.entries e                    │  │
│  │  where not exists (…)                             │  │
│  └───────────────────────────────────────────────────┘  │
│                                                         │
│  Then re-run the job with `--from`.                     │
│                                                         │
│                                            [ edit ]     │
└─────────────────────────────────────────────────────────┘
```

The button sits in the bottom right of the pane and says `edit`; in edit
mode it stays in the same place and says `view`. One control, one
position, two labels — a control that moves when you press it costs
people the second press.

Mode is per **view**, not per document. Splitting a markdown document to
read it beside its own source is a thing people do, and it is free if
mode is a view property. It rides on the Dockview panel's parameters —
which are already serialised with the layout — rather than a store of
its own, so a tab you left in edit mode reopens in edit mode with no new
persistence to keep in sync.

A `sql` document has no button and no mode. Nothing in the pane moves
for the language that does not need it.

### Rendering

`marked`, configured with GitHub-flavoured markdown, no raw HTML, and no
external resource loading:

- **HTML is escaped, not sanitized.** A `<script>` in the file renders
  as the text `<script>`. Escaping is a property of the parser
  configuration; sanitizing is a filter somebody has to keep ahead of an
  attacker. The first one has no bypass to find.
- **Links** render, open in a new tab, and carry
  `rel="noreferrer noopener"`. A link to a relative path in the
  repository resolves against the document's origin directory and opens
  that file in DataGripe when it is a file the editor can open — this is
  the case that makes a `docs/` folder in a checkout worth reading here
  at all.
- **Images** are not fetched. A remote image would be a beacon and a
  relative one is a file the server would have to serve; both render as
  the link text with the source beside it.
- **Tables, task lists, footnotes and headings** render. Headings get no
  anchor links: there is no URL to link to.
- Rendering is memoised on document content, because a markdown document
  under a debounced gripe runner re-renders on every keystroke otherwise.

The rendered pane uses the same type scale and colour tokens as the rest
of the app (`apps/web/src/styles/tokens.css`). It is not a document
theme; it is DataGripe with markdown in it.

### SQL blocks

Fenced blocks whose info string is `sql` (case-insensitive, and
`postgresql`/`mysql`/`sqlite` alias to it) are extracted before render
and replaced by a block component. Every other fence renders as a plain
code block, monospaced and unstyled — highlighting eleven languages is a
different project.

A SQL block is:

- **A read-only Monaco instance**, not a `<pre>`. It costs a model and
  buys the exact tokenizer, theme and font the editor uses, which is
  what makes the block read as *the same SQL* as the tab next door.
  Blocks are created lazily as they scroll into view and disposed when
  the panel unmounts, because a 40-block runbook should not be 40
  editors on open.
- **Runnable.** The `▶` in the block's top right runs its contents
  through `execution.start` — the same action, the same registry, the
  same limits, the same results panel bound to this document, the same
  cross-user audit trail (`docs/spec/query-execution.md`,
  `docs/spec/multiplayer.md` 6d/6e). A block is a selection that happens
  to be delimited by backticks.
- **Bound to the document's connection**, resolved by
  `connectionIdForDocument` exactly as the editor resolves it, falling
  back to the workspace default. A markdown document with no connection
  shows the run button disabled with the reason, in the same words the
  editor uses.
- **Analysed.** The gripes runner (`docs/spec/gripes.md`) sees the
  document with everything that is not a `sql` fence **blanked out,
  character for character** — same length, same line breaks. So a
  `delete` with no `where` in a runbook is a blocker in the gripes panel
  and in the status bar count, at the offset it actually occupies.
  Blanking beats extracting: an extract needs an offset map, and an
  offset map is a thing that can be wrong.

Multiple blocks do not share a session. Running the third block does not
run the first two, and there is no "run all" — a runbook is a set of
things you might do, not a script.

### Editing

Edit mode is the editor the app already has, with Monaco's `markdown`
language on the model, plus one thing: **the SQL features work inside
`sql` fences.**

Monaco does not do embedded languages, so this is done at the provider
seam rather than the grammar seam. Completion, formatting and hover are
registered for `markdown` as thin wrappers that:

1. find the fence containing the position, by scanning fence delimiters
   from the top of the model;
2. return nothing at all when the position is not inside a `sql` fence —
   markdown prose must not get table-name completion;
3. otherwise delegate to the existing SQL provider with the position and
   offsets translated into fence-local coordinates, and translate the
   results back.

That gives, inside a fence and nowhere else: schema-aware completion
(`docs/spec/editor-workspace.md`), Ctrl+Alt+L formatting scoped to the
fence rather than the document, and the gripe squiggles and gutter
glyphs already described above. Formatting the whole document when the
caret is in prose does nothing rather than running the SQL formatter
over a paragraph.

Save, revision guard, presence, followed cursors and the disk-conflict
banner are unchanged — a markdown document is a document
(`docs/spec/multiplayer.md`, `docs/spec/datasource-paths.md`).

Followed cursors are an edit-mode thing. A follower in view mode simply
does not see the leader's caret — see "What is not built".

### The sidebar and the tabs

- File trees show `.md` files with their own glyph, so a runbook is
  visibly not a query.
- The tab title is the filename, as it already is. The editor tab's
  dirty dot, the gripe severity marks and middle-click-to-close all work
  unchanged.
- Executing from a markdown document records history rows exactly as the
  editor does, so `history.list` shows the query with the document it
  came from.

## Testing

- **Extension rule.** `a.md`, `a.MD`, `a.markdown` are markdown;
  `a.sql`, `a`, `a.md.sql`, `a.json` are sql. Renaming `notes.sql` to
  `notes.md` changes the language on save and broadcasts it.
- **No HTML.** A file containing `<script>alert(1)</script>`,
  `<img onerror=…>` and an `<iframe>` renders three pieces of visible
  text and produces no element of those types in the pane.
- **Link handling.** An `http` link gets `rel="noreferrer noopener"`; a
  relative link to a sibling `.sql` opens that file; a relative link
  that climbs out of the datasource path is inert.
- **Block extraction.** Fences with info `sql`, `SQL`, `postgresql` and
  ` sql ` become blocks; ```` ```bash ```` and an unfenced indented block
  do not. An unterminated fence at end of file renders as a block and
  does not eat the rest of the document.
- **Execution parity.** Running a block and running the same text as a
  selection in a `.sql` document produce the same request payload,
  including the connection ref and the limits.
- **Offsets.** A gripe in the second of three blocks reports a document
  offset that lands inside that block's text, asserted against the raw
  file content and not against the rendered output.
- **Provider scoping.** Completion at a position in prose returns
  nothing; at a position inside a `sql` fence it returns the same
  suggestions the SQL provider returns for the fence-local position.
  Ctrl+Alt+L with the caret in a fence rewrites only that fence's bytes.
- **Mode persistence.** A view left in edit mode reopens in edit mode
  after reload; a second view of the same document keeps its own mode.
- **Disposal.** Opening and closing a 40-block document twice leaves no
  Monaco models behind.

## What is not built

- **Preview beside editor.** Two modes, one pane. Splitting the tab
  gives you both, and that already works.
- **Highlighting for non-SQL fences.**
- **Front matter.** A leading `---` block renders as a horizontal rule
  and a paragraph, like anywhere else that has not special-cased it.
- **Mermaid, math, admonitions.**
- **Creating a markdown file from the sidebar.** The path tree is not a
  file manager (`docs/spec/datasource-paths.md` "Non-goals"), so a new
  `.md` in a checkout is made by the tool that owns the checkout. A
  workspace file or scratchpad named `.md` is the way in for now.
- **Followed cursors in view mode.** A leader's caret is a position in
  the source, and the rendered pane has no such position to put it in.
  Showing "the block they are in" was specified and then dropped: it is
  a second, weaker notion of following that would have to be explained
  every time somebody noticed the difference. Switching to edit gives a
  follower the real thing.
- **A dirty dot in the rendered pane.** The mode button is the only
  chrome the pane has; the tab already carries the dot.

## Open questions

- Whether a block should be editable in view mode. It is the obvious
  next request and it is a trap: an edit in a read pane has to write
  back into the source at an offset, and the pane has no dirty state to
  hang it on. Deferred until somebody actually asks.
- Whether run results belong under the block rather than in the results
  panel. Under the block reads better and reflows the document under a
  running query; the results panel is where every other execution goes.
- Whether `docs/spec/gripes.md` should get a markdown-specific rule
  class — "this runbook's query references an object that no longer
  exists" is the most valuable gripe in the catalogue and needs a
  catalog the runner does not have at analysis time.
- Whether the language should be a per-document override rather than
  strictly derived from the extension, for the `README` with no
  extension. Cheap to add, and one more piece of state that can disagree
  with the filename.
