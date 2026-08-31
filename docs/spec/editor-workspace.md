# Spec — Editor workspace

**Status:** current
**Phase:** 1
**Supersedes:** nothing (implements `docs/initial_idea.md` §5)

## Goal

An IDE-grade editor shell in the browser: many SQL documents open at once,
tabs that move between groups, horizontal/vertical splits, and no lost
changes across tab switches, splits, reloads, or browser crashes.

## Non-goals

- Server-side document persistence. Phase 1 is deliberately client-only:
  there is no authenticated user or seeded workspace yet (auth lands in
  Phase 4), so IndexedDB is the source of truth. The `document.*` and
  `layout.save` WebSocket actions already exist in
  `packages/contracts/src/ws.ts`; wiring the stores to them is a later
  phase and must not change the store semantics defined here.
- Query execution, result grids, connections, explorer (Phases 2–3).
- Multiplayer/shared documents (Phase 6, `docs/spec/multiplayer.md`).
- Rich tab context menus, drag-and-drop onto the sidebar, popout windows.

## Definitions

| Term | Meaning |
| --- | --- |
| Document | A named SQL file. Domain state lives in the Zustand document store; durable copy in the Dexie `documents` table |
| View | One Dockview panel hosting one Monaco editor on a document's model. Many views may share one document |
| Model | The Monaco text model for a document (`datagripe://document/{id}.sql`); owns undo history |
| Draft | Unsaved content checkpointed to the Dexie `drafts` table after each edit burst |
| Layout | Dockview's serialized workspace (panels, groups, splits) in the Dexie `layouts` table |
| View state | Cursor, selection, and scroll position per view, in the Dexie `viewStates` table |

## Design

### State ownership

The layering from `docs/initial_idea.md` §5 applies unchanged:

- **Zustand document store** is authoritative for domain state: document
  list, titles, saved vs current content, dirty flags, revisions.
- **Monaco** is authoritative for active in-memory editing and undo
  history. Store updates flow from `onDidChangeModelContent`, never from
  re-setting editor values.
- **IndexedDB (Dexie)** is the crash-recovery and reload layer. The UI
  never reads it after boot; all writes are fire-and-forget from store
  subscriptions and editor events.

### Document model

```ts
type EditorDocument = {
  id: string;             // uuid
  title: string;          // unique-ish display name, e.g. "query-1.sql"
  language: "sql";
  savedContent: string;   // content at last explicit save
  currentContent: string; // live content, may differ from savedContent
  revision: number;       // increments on every save
  dirty: boolean;         // currentContent !== savedContent
  createdAt: string;      // ISO 8601
  updatedAt: string;      // last edit or save
};
```

`revision` exists so the later server sync can adopt
`WHERE id = ? AND revision = ?` guarded saves without a model change.

### Persistence schema (Dexie, database `datagripe`, version 1)

| Table | Key | Row |
| --- | --- | --- |
| `documents` | `id` | `{ id, title, content, revision, createdAt, updatedAt }` — last saved state |
| `drafts` | `id` (= document id) | `{ id, content, baseRevision, updatedAt }` — latest unsaved checkpoint |
| `layouts` | `id` (= `"local"`) | `{ id, json, updatedAt }` — `SerializedDockview` |
| `viewStates` | `id` (= panel id) | `{ id, documentId, state, updatedAt }` — `monaco.editor.ICodeEditorViewState` |

There is exactly one implicit local workspace, so the layout row id is the
constant `"local"`. Multi-workspace keying arrives with server sync.

### Write paths

- **Edit** → Monaco change event → `updateContent` in the store →
  debounced (750 ms, per document) upsert into `drafts` with the document's
  saved `revision` as `baseRevision`. Pending checkpoints flush when the
  last view of a document unmounts and on `beforeunload` (best effort).
- **Save** (Ctrl/Cmd+S or Save button) → write `currentContent` to
  `documents`, `revision += 1`, then delete the draft row. Order matters:
  a crash between the two writes leaves a recoverable draft, never a lost
  save. Ctrl/Cmd+S is handled by one window-level listener routed to the
  view with Monaco text focus (tracked via `onDidFocusEditorText`),
  falling back to Dockview's active panel when focus is on a tab header.
  Per-editor `editor.addCommand` bindings are deliberately not used:
  Monaco command registrations are global, so identical keybindings from
  multiple editor instances collide and the latest editor shadows the
  rest.
- **Layout change** → Dockview `onDidLayoutChange` → debounced (500 ms)
  `toJSON()` into `layouts`.
- **View state change** (cursor/selection/scroll) → debounced (500 ms)
  `editor.saveViewState()` into `viewStates`; also written when a view
  unmounts.

### Boot / recovery

1. Load all `documents` and `drafts` rows.
2. Merge: a draft row wins over its document's saved content
   (`currentContent = draft.content`, `dirty = true`) whenever the draft is
   newer than the document row. A draft whose document row was deleted is
   dropped. This is the "never silently overwrite a newer draft" rule;
   comparing against a *server* revision joins this merge when sync lands.
3. Hydrate the document store.
4. Load the `layouts` row; validate the shape with Zod and drop panels
   whose `params.documentId` no longer exists (`sanitizeLayout`). Apply
   with `fromJSON`. Any failure → start with an empty workspace showing the
   watermark. A corrupt layout must never block editing.
5. Each restored panel mounts an `EditorView`, which acquires the document
   model and restores its view state from `viewStates`.

### Monaco model registry

One model per document, owned by `createModelRegistry`:

- `acquire(document)` returns the shared model, creating it from
  `currentContent` on first use; a reference count tracks live views.
- `release(documentId)` decrements; at zero the registry disposes the
  model after a microtask delay so StrictMode remounts and Dockview panel
  moves (which unmount and remount the React component) do not churn model
  creation or lose undo history.
- Disposal first invokes an `onRelease` flush so the final content is
  checkpointed to `drafts` before the model goes away.
- Editors switch documents exclusively with `editor.setModel(model)`;
  `setValue` on tab switches is forbidden (it destroys undo history and
  view state).

The registry takes its model factory as a parameter, so the reference
counting and flush-on-dispose logic is unit-tested without Monaco.

### Views and Dockview

- Each panel id is a stable `view-{uuid}`; the document binding travels in
  panel `params.documentId`, which Dockview serializes into the layout, so
  view→document bindings survive reload.
- Editor panels use `renderer: "always"` so hidden tabs keep their editor
  instance; tab switches are pure visibility changes.
- A custom tab component shows the title and a dirty dot. Tab close
  removes the view only; the document and any dirty draft are retained
  until the user explicitly deletes the document in the sidebar.
- Dragging tabs between groups and dropping on group edges creates
  horizontal/vertical splits — stock Dockview behavior, no custom DnD.
- A Zustand view store mirrors Dockview's panel inventory
  (`viewId → { documentId }`, plus `activeViewId`) for React consumers
  (sidebar, save-command routing). Dockview remains the source of truth;
  the store is a read model fed by `onDidAddPanel` / `onDidRemovePanel` /
  `onDidActivePanelChange`.

### UI structure

```text
┌──────────────────────────────────────────────┐
│ header: DataGripe · New query · Save         │
├───────────┬──────────────────────────────────┤
│ documents │  Dockview workspace              │
│ sidebar   │  (editor panels, splits, tabs)   │
└───────────┴──────────────────────────────────┘
```

The sidebar lists every document (dirty dot, click to focus or open,
double-click to rename, delete to discard). It is plain React, not a
Dockview panel — it has no close semantics and must always be reachable.
The empty workspace shows a Dockview watermark with a New query button.

## Client–server sync boundary (later phases)

The contracts for `workspace.open`, `document.get/create/save/archive`,
and `layout.save` are already defined. Sync plugs in at three seams
without store-shape changes:

1. Boot merge gains a server-revision comparison in step 2.
2. `saveDocument` additionally sends `document.save` with the idempotency
   key; `409 Conflict` surfaces in the UI instead of overwriting.
3. Layout save additionally sends `layout.save` with its revision guard.

## Open questions

- Draft retention policy for deleted-but-dirty documents (currently:
  delete removes document, draft, and view states immediately).
- Whether the sidebar becomes a Dockview panel once tool windows
  (explorer, history) arrive in Phase 2–3.
- Autosave cadence to the server once sync lands (explicit save only, or
  conservative background saves per `docs/initial_idea.md` §5).
