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
`execution.start/cancel`, `workspace.member.add/remove`, `ssrf.blocked`,
`domain.create/update/delete/tag`, `domain.export`, `domain.import`,
`domain.git`, `domain.set-export-path`, `access.roles.set`.
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

### Domain export and git (docs/spec/domains.md, docs/spec/git-datasources.md)

Export is the one action in DataGripe that writes to the host
filesystem, and `domain.git` is the only one that runs a subprocess.
Both are **off by default** and both are `owner`-only.

- `HOST_FS_DISABLED` (default `false`) — turns off **every**
  host-filesystem feature: the domain export and import, the
  datasource paths the sidebar browses
  (`docs/spec/datasource-paths.md`), and git datasources
  (`docs/spec/git-datasources.md`). This is the switch a hosted,
  multi-tenant deployment sets; there, the person pressing the button
  does not own the disk.
- `HOST_FS_ROOTS` — an **optional** colon-separated allowlist of
  absolute directories the server may read and write on behalf of a
  workspace. Empty (the default) means no allowlist: the directory is
  already named explicitly per datasource, and making people configure
  the same thing twice bought nothing. Set it when the host is shared
  with people who do not own it. Either way the configured directory
  must be absolute, and is re-resolved with `realpath` and checked
  segment-wise against this list on *every* access, so a symlink
  swapped in later is caught. The paths themselves are set per
  datasource on its edit page, not per project — an export never
  crosses a datasource boundary.
- `DOMAIN_EXPORT_ROOTS` — the pre-rename name for `HOST_FS_ROOTS`,
  still honoured when `HOST_FS_ROOTS` is unset. Note the changed
  default: an empty value used to mean "export disabled" and now means
  "no allowlist". A deployment that relied on empty-means-off must set
  `HOST_FS_DISABLED=true`.
- `GIT_ENABLED` (default `false`) — enables **every** git feature:
  `domain.git`'s commit controls and git datasources
  (`docs/spec/git-datasources.md`). When off they are absent, not
  disabled. Git runs with argv (never a shell), a fixed verb list,
  every user-supplied value after a `--`, and `GIT_TERMINAL_PROMPT=0`
  so a missing credential errors instead of hanging. DataGripe manages
  no credentials: `HOME`, `PATH` and `SSH_AUTH_SOCK` pass through and
  git's own stderr is shown verbatim. `DOMAIN_EXPORT_GIT` is the
  pre-rename name and is still honoured.
- `GIT_REPOS_DIR` (default `<data dir>/repos`) — where
  `git.datasource.add` clones to, one directory per datasource.
  DataGripe deletes a directory only when it created it and only under
  this root; an adopted checkout is never deleted.
- `GIT_TIMEOUT_MS` (default 60000) — every git invocation is killed at
  this. `DOMAIN_GIT_TIMEOUT_MS` is the pre-rename name.
- `GIT_CLONE_TIMEOUT_MS` (default 600000) — clone gets its own budget,
  because a big repository is not a hung one.
- `REPO_COMMANDS_ENABLED` (default `false`) — lets a repository's
  `.datagripe/run.yaml` declare commands DataGripe can run
  (`docs/spec/repo-commands.md`). **Its own switch on purpose:** every
  other git feature reads and writes files, and this one executes a
  program somebody else wrote, arriving over the network on `git pull`.
  Wanting git datasources is not the same decision as wanting arbitrary
  execution. Needs `GIT_ENABLED` as well.

  Even on, nothing runs until somebody approves the command list, and
  any change to it — including one a pull brought in — needs a fresh
  approval. Commands run as the server user with `owner` role, with an
  allowlisted environment that excludes `CONNECTION_ENCRYPTION_KEY` and
  `SESSION_SECRET`. The approval *is* the security boundary; there is
  no sandbox.
- `REPO_COMMAND_TIMEOUT_MS` (default 600000) — hard ceiling for one
  non-background command, whatever it asked for.
- `REPO_COMMAND_DEFAULT_TIMEOUT_MS` (default 120000) — used when a
  command declares no `timeoutSeconds`. A `background: true` command has
  no deadline at all and runs until stopped or the server exits.
- `DOMAIN_EXPORT_MAX_DATA_ROWS` (default 10000) — per-table cap for
  `includeData` domains. Over it, the table is refused and reported
  rather than written truncated.
- `ACCESS_REPORT_MAX_CELLS` (default 250000) — the access report counts
  its cells first and refuses above this, asking for a schema or domain
  filter (docs/spec/access-report.md).

In a hosted, multi-tenant deployment, set `HOST_FS_DISABLED=true` and
leave `GIT_ENABLED` and `REPO_COMMANDS_ENABLED` unset. Host-filesystem access exists for the
local and desktop shape, where the person pressing the button owns the
checkout.
