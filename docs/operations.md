# Operations

Deployment-facing procedures for DataGripe. Development setup lives in
`docs/initial_idea.md` §13; this document covers keeping a deployment
alive.

## Backup and restore

DataGripe's durable state is the application PostgreSQL database
(`APP_DATABASE_URL`): accounts, sessions, workspaces, connection
metadata + encrypted secrets, documents, layouts, and query history.
Target databases are never backed up by DataGripe.

### Backup

```bash
pg_dump --format=custom --file=datagripe-$(date +%Y%m%d-%H%M).dump "$APP_DATABASE_URL"
```

Notes:

- `connection_secrets.ciphertext` is encrypted with
  `CONNECTION_ENCRYPTION_KEY`. A backup without the key is useless for
  target access — store the key with the same care as the backup, but
  not in the same place.
- Sessions become invalid on restore only if you also rotate
  `SESSION_SECRET`; both can coexist safely.

### Restore (verified 2026-08-31 against the local compose container)

```bash
createdb datagripe_restore
pg_restore --dbname=datagripe_restore datagripe-YYYYMMDD-HHMM.dump
APP_DATABASE_URL=postgres://…/datagripe_restore bun run db:migrate
```

Run `db:migrate` after every restore: migrations are idempotent and
bring older backups up to the current schema before the server starts.
Verification practice: restore quarterly into a scratch database and run
`SELECT count(*) FROM users; SELECT count(*) FROM connections;` against
both databases and compare.

## Load testing

`scripts/load-test.ts` drives a running server through the real
WebSocket protocol: login, `workspace.open`, `schema.children`, and
`execution.start` ("select 1") at a chosen concurrency.

```bash
bun scripts/load-test.ts --url http://localhost:3001 \
  --email you@example.com --password '…' --concurrency 10 --requests 200
```

Reference numbers (2026-08-31, dev container Postgres 17, single Bun
server, localhost, via the Vite proxy):

| Workload | Concurrency | Result |
| --- | --- | --- |
| `execution.start` (`select 1`, awaited to terminal) | 3 | p50 4–6 ms, p95 7–14 ms per execution |
| `schema.children` (cached schemas) | 10 | p50 <1 ms, p95 7 ms |

Sustained bursts hit the configured limits by design:
`execution.start` rejects with `RATE_LIMITED` beyond 30/min per user,
and admissions beyond `MAX_CONCURRENT_QUERIES_PER_USER` reject with
"Too many concurrent queries". A 200-request mixed burst at concurrency
10 exercised both limiters (88 rejections, zero server errors, latencies
flat). Re-run after schema or pool changes.

## Audit log

Security-relevant events are structured JSON on stdout with
`"msg":"audit"`: `auth.signup`, `auth.login.success`,
`auth.login.failure`, `auth.logout`, `connection.create/update/delete`,
`execution.start/cancel`, `workspace.member.add/remove`, `ssrf.blocked`.
Pipe to your log stack and alert on `auth.login.failure` bursts and any
`ssrf.blocked`. Secrets and result values are never logged.

## Configuration checklist (production)

- `NODE_ENV=production` (enables the `Secure` cookie attribute).
- `ALLOW_SIGNUP=false` after provisioning accounts.
- `TARGET_HOST_ALLOWLIST` empty unless private targets are intentional —
  the SSRF policy blocks private ranges by default. `SSRF_DISABLED=true`
  disables the policy entirely; use only on trusted networks, since the
  server will then connect to any host (including loopback and cloud
  metadata endpoints).
- `CONNECTION_ENCRYPTION_KEY` from your secret manager; rotation
  procedure: add the new key as version 2 in `crypto/keyring.ts`
  wiring, restart, and re-save connections opportunistically (old
  versions keep decrypting).
- `WEB_ORIGIN` set to the exact origin the app is served from; both
  HTTP and the WebSocket upgrade enforce it.
