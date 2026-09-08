# Spec — Repository commands

**Status:** current
**Phase:** 14
**Supersedes:** nothing (extends `docs/spec/git-datasources.md`)

## Goal

A datasource that comes from a repository can bring its own directories,
its own domains and its own sync target. What it still cannot bring is
the database. Somebody clones the example repo, opens DataGripe, and the
datasource points at a PostgreSQL that does not exist yet — so the first
thing they read is a connection error, and the second thing they do is
go and find a README.

A repository can declare **commands**: named, argv-form programs
DataGripe will run in the checkout. The motivating one is "start the
database" — an embedded PostgreSQL under the checkout, seeded with the
example schema on first run — so a clone is a working project rather
than a working project's configuration.

This is the only feature in DataGripe that runs a program it did not
write, and the rest of this document is mostly about that.

## The thing that makes this dangerous

Everything else in `.datagripe/` is **data DataGripe interprets**. A
malicious `config.yaml` can at worst point at a database or name a
directory, and both are checked. `run.yaml` is **a program somebody else
wrote**, and it arrives over the network on `git pull`.

So the question is not "is this file valid" but "did a person here agree
to run *this*". Three answers, and all three are load-bearing:

1. **Its own switch.** `REPO_COMMANDS_ENABLED`, separate from
   `GIT_ENABLED`. Wanting git datasources is not the same decision as
   wanting arbitrary execution, and the two must not share a checkbox.
   Off by default.
2. **Explicit approval, re-earned on change.** The command list is
   hashed; a person approves that hash; any change needs a fresh
   approval. Without this step, `git pull` is remote code execution with
   a friendly button — and the person who pulls is not the person who
   wrote the change.
3. **`owner` role**, for both approving and running.

## Non-goals

- **Not a task runner.** No dependencies between commands, no ordering,
  no scheduling, no "run on open". Every run is a press.
- **Not a shell.** `run` is an argv array. There is no string form, no
  interpolation and no expansion, so there is nothing to quote and
  nothing to inject into. A command that wants a pipeline writes a
  script and names the script.
- **Not a process manager.** A background command lives as long as the
  server process does. There is no supervision, no restart, no health
  check, and nothing survives a server restart.
- **Not sandboxed.** An approved command runs as the server user with
  the server user's filesystem access. The approval *is* the security
  boundary; the runner narrows the environment but does not pretend to
  contain anything.
- **No output persistence.** Transcripts live in memory for the session.

## Design

### `.datagripe/run.yaml`

```yaml
version: 1
commands:
  - name: start database
    description: >-
      Starts an embedded PostgreSQL under .datagripe-local/ and seeds the
      example schema the first time.
    run: ["bun", "run", "scripts/dev-db.ts", "start"]
    background: true

  - name: reset database
    description: Stops it and deletes the cluster, so the next start reseeds.
    run: ["bun", "run", "scripts/dev-db.ts", "reset"]
    timeoutSeconds: 60
```

- **`run` is argv.** The first element is the program; it is resolved
  through `PATH` and nothing else.
- **`cwd`** is repo-relative and goes through the same `resolveRepoPath`
  as every other path in this directory: absolute is refused, `..` is
  refused, and a symlink out is refused after `realpath`.
- **`env`** values are literal. `$HOME` is four characters.
- **`background: true`** means a service rather than a task. The
  difference that matters is the timeout: a task that has not finished
  in its budget has hung and gets killed, while a database that has been
  up for ten minutes is working. It is declared in the file — and so
  visible in the approval list — rather than inferred from how long
  something happens to take.
- A repository with no `run.yaml` has no commands, which is not an error
  and is the normal case.

### Trust

`git_datasource_trust` (migration 0016), one row per
`(workspace, datasource)`: the approved hash, who approved it, when.

The hash covers the **semantic** command list — name, argv, cwd, env,
timeout, background — normalised and sorted. Reformatting the YAML,
reordering keys or editing a comment does not invalidate an approval;
changing a single argument does. Comments are deliberately outside it,
because a comment cannot change what runs.

- **Per workspace, not per person.** A project is a set of people who
  already share a database and a checkout. Making each of them approve
  the same list separately would train everybody to click through it.
  One person vouches, and the audit line records who.
- **The client sends back the hash it was shown.** If the file moved
  between somebody reading it and pressing approve, the approval is
  refused rather than applied — what they approved has to be what they
  saw.
- **`repo.run` re-checks against disk**, not against what the panel had.
  The list on disk now is what would run.
- The two untrusted states are worded differently, because they are
  different. "Never approved" is a normal first-run step. **"Changed
  since it was approved"** is the one a pull can produce without anybody
  noticing, and it says so in as many words.

### Running one

`Bun.spawn` with the argv from the file, and:

- **A narrow environment**, built as an allowlist rather than by
  filtering the server's own: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TERM`,
  `TMPDIR`, plus whatever the command declared, plus `DATAGRIPE_RUN=1`
  and `CI=1` so a script can tell it is not being run by a person. The
  server process holds `CONNECTION_ENCRYPTION_KEY` and `SESSION_SECRET`;
  a command from a repository must not inherit them because nobody
  thought to remove them.
- **stdin is ignored.** A command that prompts gets EOF rather than
  hanging forever, which is the same posture as `GIT_TERMINAL_PROMPT=0`.
- **stdout and stderr stream verbatim**, interleaved in arrival order,
  and the exit code is the verdict. Reordering the two streams would
  produce a log that no longer matches what a terminal would have shown.
- **SIGTERM, then SIGKILL after five seconds.** A command that started a
  database deserves the chance to shut it down cleanly; one that ignores
  the chance does not get to hold the slot.
- Every invocation writes an audit line carrying **the whole argv**, not
  the name of the button that was pressed.

Output is broadcast to the **workspace**, not to the socket that started
the run: a run that starts a database affects everybody in the project,
and the person who pressed the button may well close the tab.

### What the sidebar shows

Inside the repository section, below the git buttons, because they are a
different kind of thing — git moves files around, this runs a program.

```
├ repository ─────────────────┤
│ main · ↑0 ↓0                │
│ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│ [ commit… ] [ push ] [ pull ]│
│ ┄┄ commands ┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│ This repository declares     │
│ commands DataGripe can run.  │
│ Nothing runs until somebody  │
│ here approves them.          │
│ [ review what would run ]    │
└──────────────────────────────┘
```

Reviewing shows each command's **argv**, not its name — the name is the
repository's word for what it does and the argv is what it does. The
approve button only appears once the list has been expanded, so
approving without looking takes two deliberate presses rather than one.

Output goes to a `run: <datasource>` dock tab, like the sync tab, and
for the same reason: it is a run you watch and read, and a 240px rail is
a bad place to read a seeding log.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `REPO_COMMANDS_ENABLED` | `false` | The feature. Needs `GIT_ENABLED` and a usable host filesystem as well |
| `REPO_COMMAND_TIMEOUT_MS` | `600000` | Hard ceiling for a non-background command, whatever it asked for |
| `REPO_COMMAND_DEFAULT_TIMEOUT_MS` | `120000` | Used when a command declares no `timeoutSeconds` |

## Testing

- **Approval gates execution.** `repo.run` against an unapproved list
  refuses and spawns nothing.
- **A changed list revokes trust.** Approve, edit one argument, and the
  state reports `trusted: false` with the changed-since wording; running
  refuses.
- **Reformatting does not revoke trust.** Reindent the YAML, reorder
  keys within a command, add a comment — the hash is unchanged.
- **The approval hash must match disk.** An approval carrying a stale
  hash is refused.
- **argv is argv.** A command whose argument is `; rm -rf /` passes that
  string to the program as one argument and runs no shell.
- **The environment is an allowlist.** A command cannot see
  `CONNECTION_ENCRYPTION_KEY` or `SESSION_SECRET` even though the server
  process has them.
- **cwd containment.** `cwd: ../elsewhere` and an absolute `cwd` are
  refused.
- **Timeouts.** A non-background command that outlives its budget is
  killed and reported as killed with the reason; a background command is
  not killed by any budget.
- **Cancel.** A running command stops on request, and the panel reports
  it as stopped rather than as a failure.
- **Duplicate names refuse**, because `repo.run` picks by name.

## What is not built

- **Restart on server boot.** A background command dies with the
  process that started it, and nothing brings it back. Supervision is a
  different feature and it should not arrive by accident.
- **Per-command approval.** The list is approved as a unit. Approving
  three of four commands is a state that reads well and is hard to keep
  honest as the file changes.
- **Output persistence or a run history.** `domain_exports` exists
  because an export produces an artifact worth attributing; a command's
  transcript is a terminal, and terminals scroll away.
- **Anything reading the exit code and acting on it** — no "seed the
  database, then run the export".

## Open questions

- Whether a background command should be adoptable across a server
  restart by recording its pid. It would need a liveness check that
  cannot be fooled by pid reuse, which is more machinery than the
  feature currently earns.
- Whether the approval should expire. A repository nobody has pulled in
  six months is not more dangerous than it was, so probably not — but a
  repository that has been pulled forty times since is a different
  argument.
- Whether `repo.run` should be `editor` when the command is declared
  `background: false` and the repository is one DataGripe cloned itself.
  That is three conditions to explain, which is usually the sign of a
  rule that should stay simple.
- Whether the run panel should offer to open a psql-ish console against
  whatever the command started. It is the obvious next request and it is
  a terminal emulator, which this is deliberately not.
