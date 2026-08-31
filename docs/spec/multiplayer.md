# Spec — Multiplayer

**Status:** draft
**Phase:** 6 (post-MVP; 6a may land earlier if trivial)
**Supersedes:** nothing (extends `docs/initial_idea.md` §10 presence note)

## Goal

DataGripe is multiplayer. Staged delivery:

1. **Shared files (6a):** every workspace member can open, edit, and save the
   workspace's documents. No live collaboration — last save wins, guarded by
   the existing revision/409 machinery.
2. **Presence (6b):** see who is online and which document they have open.
3. **Shared views (6c):** opt-in "follow" of another member: their cursor,
   selection, and scroll are rendered in your editor; you may detach at any
   time.
4. **Shared execution (6d):** members see each other's query history and
   live executions on shared connections, can open the results, and can run
   queries on shared connections **under their own identity**.
5. **Audit (6e):** cross-user actions are recorded with actor attribution.

## Non-goals

- Real-time collaborative text editing (CRDT/OT). Explicitly out of scope;
  the revision-guard save model stays.
- Sharing cursors/results outside a workspace.
- Anonymous or link-based sharing.

## Design

### Identity and authority

All multiplayer features ride the existing authenticated WebSocket
(`docs/initial_idea.md` §10). The socket is already bound to `userId` +
`sessionId`; every action is re-authorized against the workspace. Multiplayer
adds no new trust boundary — it widens what workspace members may see.

### 6a — Shared files

- Documents are already workspace-scoped (`documents.workspace_id`).
- Authorization predicate changes from "owner" to "workspace member with
  role `editor` or `owner`" once `workspace_members` is enforced in Phase 4.
- Save conflicts across users surface the existing 409 conflict flow; the
  client offers reload/keep-mine, never silent overwrite.

### 6b — Presence

- Server keeps an in-memory presence map per workspace: userId →
  { activeDocumentId, lastSeenAt }.
- New server event topic `presence.update`, broadcast on socket
  join/leave and on `document.focus` client actions (throttled to 1 Hz per
  user).
- Presence is ephemeral: never written to the database.

### 6c — Shared views (cursor following)

- A member publishes cursor/selection/scroll as throttled events:
  client action `view.broadcast` (≤ 4 Hz, payload < 1 KiB) → server event
  `view.state` to subscribers of the same document.
- Following is opt-in per viewer: client subscribes with
  `view.follow { userId }` / `view.unfollow`. The followed user is notified
  (event `view.followed`) and can block followers in settings.
- Remote cursors render as Monaco decorations owned by the client; the
  server stores nothing. `EditorViewState` stays local-only.
- Disconnect clears all published view state immediately.

### 6d — Shared execution visibility

- `query_executions` gains nothing new: `user_id` is the actor,
  `connection_id`/`connection_ref` the target. History queries become
  workspace-scoped instead of user-scoped (role `viewer` and above).
- Live executions broadcast lifecycle events to workspace subscribers, not
  only the executor. Row payloads are sent only to clients subscribed to
  that `executionId` (existing `execution.subscribe` gains an authorization
  check: any workspace member may subscribe).
- **Running queries uses the executor's own identity.** The audit record and
  any database-role attribution always name the user who pressed run, never
  the connection's creator. A shared connection grants capability, not
  impersonation.
- Cancelling someone else's execution requires role `owner` (or the
  executor themselves); attempted by others → `FORBIDDEN`.

### 6e — Audit

- Every cross-user-visible action (run, cancel, save on shared document)
  writes actor + subject to `query_executions` / a future `audit_events`
  table.
- Audit payloads redact credentials and result values per the existing
  logging rules.

### Protocol additions (contracts)

New client actions: `document.focus`, `view.broadcast`, `view.follow`,
`view.unfollow`. New event topics: `presence.update`, `view.state`,
`view.followed`. All added to `clientActionSchema` / topic unions in
`packages/contracts` when the phase starts — not before.

## Client behavior

- Explorer/sidebar shows online members with active-document labels.
- Editor gutter shows remote cursors with user colors (hash of userId).
- History panel groups by actor; filter "mine / everyone's".
- A "following" chip in the editor header shows whose view you follow and
  offers one-click detach.

## Open questions

- Follow-mode scroll sync: hard lock vs soft (DataGrip has no analog; VS
  Code Live Share semantics are the reference).
- Whether `viewer` role may subscribe to live row payloads or only to
  completed history metadata.
- Retention of presence data for "recently active" display (currently zero
  retention).
