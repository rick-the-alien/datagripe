# Spec — Authentication, authorization, and hardening

**Status:** current
**Phase:** 4
**Supersedes:** the pre-auth stub notes in `docs/spec/connections.md`
(implements `docs/initial_idea.md` §10, §12; ADR 0002)

## Goal

Every request is authenticated and workspace-authorized; credentials and
targets are protected by session, CSRF, SSRF, and rate-limit controls
that match the self-hosted deployment model.

## Non-goals

- OIDC/SAML providers (later, behind the same session contract).
- Multi-workspace switching UI (users belong to one default workspace).
- Workspace invitation emails (members are added by existing owners).
- Connect-time DNS rebinding defense (see SSRF limitations).

## Design

### Accounts and sessions

- Local email+password accounts (ADR 0002). `users.password_hash` uses
  `Bun.password` (bcrypt). Minimum password length 12.
- Signup: allowed while zero users exist (bootstrap), or when
  `ALLOW_SIGNUP=true` (development default; production operators enable
  it deliberately). The first real user also becomes `owner` of the
  migrated stub workspace (`Local`), inheriting its connections and
  history.
- Sessions: opaque 32-byte tokens, SHA-256 hashed at rest
  (`sessions.token_hash`), 14-day expiry, hourly sweep of expired rows.
  Cookie `dg_session`: `HttpOnly`, `SameSite=Lax`, `Secure` when
  `NODE_ENV=production`, path `/`.
- Logout revokes the session and closes every socket bound to it.

### CSRF and origin checks

- `GET /api/session` returns `{ user, workspace, role, csrfToken,
  wsUrl, bootstrap }`. State-changing HTTP routes (login exempt — it
  has no session yet; logout) require the `x-csrf-token` header to match
  the session's token.
- HTTP and WebSocket requests validate `Origin` against `WEB_ORIGIN`.
  The WS upgrade additionally requires the session cookie — browser
  WebSocket APIs cannot attach authorization headers.

### WebSocket authorization

Upgrade binds the socket to `{ userId, sessionId, workspaceId, role }`
(the user's default workspace: their first `workspace_members` row).
Every action handler receives this context and the dispatcher enforces
the role matrix on **every** message — socket authentication is not
object authorization (initial_idea.md §10).

| Action | viewer | editor | owner |
| --- | :-: | :-: | :-: |
| `workspace.open`, `schema.children`, `history.list`, `execution.subscribe`, `workspace.members` | ✓ | ✓ | ✓ |
| `execution.start`, `execution.cancel` | – | ✓ | ✓ |
| `connection.create/update/delete/test` | – | ✓ | ✓ |
| `workspace.member.add`, `workspace.member.remove` | – | – | ✓ |
| `document.*`, `layout.save` (server sync, later) | ✓ | ✓ | ✓ |

Violations return `FORBIDDEN`. New actions:

| Action | Payload | Result |
| --- | --- | --- |
| `workspace.members` | `{}` | `[{ userId, email, role, since }]` |
| `workspace.member.add` | `{ email, role }` | the added member |
| `workspace.member.remove` | `{ userId }` | `{}` (owners cannot remove the last owner) |

### SSRF policy (`security/ssrf.ts`)

Before opening any target connection (test, introspection, execution),
the hostname is resolved (`node:dns`) and **every** returned address is
classified. Blocked by default: loopback, RFC1918, link-local
(including 169.254.169.254 cloud metadata), ULA, multicast,
unspecified, and reserved ranges. `TARGET_HOST_ALLOWLIST` (comma
separated, exact or `*.suffix`) overrides per hostname — development
uses `localhost,127.0.0.1,::1`.

Limitation (accepted): Bun.SQL resolves hostnames itself at connect
time, so a DNS answer can change between our check and the driver's
connection (rebinding TOCTOU). Full defense requires a connect-time
address hook Bun.SQL does not expose; deployments that need it must
enforce egress at the network layer.

### Rate limits (`security/rateLimit.ts`)

In-memory token buckets, keyed per scope:

| Scope | Key | Limit |
| --- | --- | --- |
| `auth.login` | IP | 30/min |
| `auth.login` | email | 5/min |
| `connection.test` | user | 10/min |
| `execution.start` | user | 30/min |
| `schema.children` | user | 120/min |

Exhaustion returns `RATE_LIMITED` (HTTP 429 / WS error).

### Audit logging

`log.audit(event, fields)` emits structured records for:
`auth.signup`, `auth.login.success`, `auth.login.failure`,
`auth.logout`, `connection.create/update/delete`,
`execution.start/cancel`, `workspace.member.add/remove`, and
`ssrf.blocked`. Never passwords, secrets, or result values. Dispatch
logs every action's duration and outcome at debug level.

## Open questions

- Sliding session renewal vs fixed 14-day expiry (currently fixed).
- Per-workspace role selection when users join multiple workspaces.
- Lockout vs rate-limit-only for repeated login failures (currently
  rate-limit-only; audit events enable alerting).
