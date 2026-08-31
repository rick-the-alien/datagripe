# ADR 0002 — Authentication: local accounts with cookie sessions

**Status:** accepted
**Date:** 2026-08-31

## Context

`docs/initial_idea.md` §12 leaves the authentication provider open but
fixes the contract: cookie-based sessions (`HttpOnly`, `Secure`,
`SameSite`), CSRF protection on HTTP, origin-validated WebSocket
upgrades bound to the session. DataGripe's deployment model is a
self-hosted database IDE (one server, a handful of users), so an
external identity provider would be the heaviest possible default.

## Decision

Built-in local accounts as the first (and required) authentication
provider:

- Email + password registration and login against the application
  database. Passwords hashed with `Bun.password` (bcrypt).
- Bootstrap: with zero users, the first signup creates the account, its
  default workspace, and an `owner` membership. Later signups require an
  existing member to add them to a workspace (`workspace_members`).
- Opaque session tokens (32 random bytes, SHA-256 hashed at rest) in an
  `HttpOnly`, `SameSite=Lax` cookie; `Secure` outside development.
- The WebSocket upgrade authenticates via the session cookie and binds
  the socket to `userId` + `sessionId`; every action re-checks
  `workspace_members` role (socket auth is not object authorization).

OIDC/SAML remain possible later behind the same session contract — the
session store, cookie, and WS binding do not change.

## Consequences

- No external dependency for auth; works offline and in air-gapped
  deployments — important for a database tool.
- The server owns password policy and rate limiting for login (added in
  the same change).
- The pre-auth stub (`local@datagripe.local` / `Local` workspace) is
  removed; existing development databases migrate by assigning the stub
  workspace's contents to the first real user.
- Every action handler now receives an authorized context (user,
  workspace, role) instead of a global stub — viewer/editor/owner
  enforcement becomes mechanical.
