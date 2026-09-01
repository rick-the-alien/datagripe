# Spec — Workspaces

**Status:** current
**Phase:** 7
**Supersedes:** nothing (extends `docs/spec/auth-and-hardening.md`,
`docs/spec/multiplayer.md`)

## Goal

The workspace IS the project: a named container with its own members,
connections, shared files, history, and default target connection. Users
create workspaces, switch between them, and keep private IndexedDB
scratchpads that never sync.

## Non-goals

- A separate "project" concept (explicitly rejected — workspaces are it).
- Per-workspace color themes or layout templates.
- Workspace deletion/archival UI.

## Model

| Scope | Contents |
| --- | --- |
| Workspace (server) | members + roles, connections, shared documents, query history, default connection |
| Local (browser) | scratchpads, drafts, per-workspace layouts, per-document connection picks |

### Switching

- The socket binds to a workspace at upgrade (`/ws?workspace=<id>`),
  validated against `workspace_members`; an unknown/stale id falls back
  to the account's default workspace.
- Switching reconnects the socket; every `onOpen` listener rescopes:
  connections reload, presence/explorer/executions reset, shared files
  re-sync, and the per-workspace layout (`ws:<id>` in IndexedDB)
  replaces the dock. Scratchpad editors stay open across switches.
- The confirmed binding comes from `workspace.open`; the client treats
  it as the source of truth (`confirmWorkspace`).

### Documents

- **Scratchpads** (`shared: false`) live in IndexedDB only and appear in
  every workspace. They never hit the server — not even on save.
- **Workspace files** (`shared: true`) are server rows shared with all
  members, synced on open and live via `document.changed` broadcasts
  (create/save/archive). Docs synced before the flag existed self-repair
  on next sync.
- The sidebar shows "Workspace files" and "Scratchpads (local)" as
  separate sections; the header has "New scratchpad" and "New shared
  file".

### Default connection

`workspaces.default_connection_ref` (managed UUID or
`predefined:<slug>`, migration 0007). The results toolbar falls back to
it when a document has no explicit pick, labels it "workspace default",
and editors can pin the current pick via `workspace.set-default-connection`
(editor role and up).

## Open questions

- Title collisions across members (two "query-1.sql") need
  disambiguation in the sidebar.
- Whether scratchpads should ever be promotable to shared files.
