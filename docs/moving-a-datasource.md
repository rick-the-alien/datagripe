# Moving a datasource to another machine

You added a datasource here and you want it on another machine, or in a
teammate's checkout, without pasting a connection string a second time
and without a password ending up in a repository.

This already works. Nothing below is new; it is the Phase 14 git
datasource flow (`docs/spec/git-datasources.md`) read from the point of
view of somebody who just wants their connection somewhere else.

## The short version

1. **Export config** on the datasource's edit page, into a directory.
2. Commit and push that directory.
3. On the other machine, **Import** → clone the URL.
4. Give it the password there.

There is no separate re-import step, and step 4 is the only thing you
type twice — deliberately, because the alternative is a password in git.

## What each step does

### 1. Export config

On the edit page of any managed or predefined datasource. It generates
the `.datagripe/` set from what the datasource already has and writes it
into a directory you name:

```
.datagripe/config.yaml    the connection, branding, path pairs
.datagripe/sync.yaml      the domain export directory and its options
.datagripe/domains.yaml   your domains, when there are any visible ones
```

`dryRun` is the default, so the YAML is shown before anything is written,
with copy-to-clipboard — half the time the destination is a repository on
a different machine. Writing over an existing `.datagripe/config.yaml`
asks first and shows what differs.

**The password is never written.** `config.yaml` carries
`passwordEnv: <NAME>` — a name derived from the datasource, so
`Wallet prod` becomes `WALLET_PROD_PASSWORD` — and the panel says so
above the button, because a placeholder that looks like a setting is
worse than a missing one. There is no `password` field in the file's
schema to fill in even by accident, reading a file with one is refused
outright, and the writer can only emit `passwordEnv` or `noPassword`.

A path that does not sit inside the target repository is written as a
comment with its absolute path and a note, not as a broken relative path.

### 2. Commit and push

The **Repository** section in the left bar, present while a git
datasource is selected: branch, ahead/behind, the porcelain rows with
checkboxes, and `commit…` / `push` / `pull` / `refresh`. Nothing is
checked by default and nothing runs on a timer.

Requires `GIT_ENABLED=true`. Export config itself does not — only
`HOST_FS_*` gates that — so you can export into a checkout and commit
with your own git if you would rather.

### 3. Import on the other machine

**Import datasource** is its own tab beside *new datasource*. Give it the
repository URL to clone, or the path of a checkout that already exists on
that host to adopt. Either way it looks for `.datagripe/config.yaml` in
the work tree root, and a repository without one is refused with the path
it looked in rather than imported as an empty datasource nobody can use.

The repository **becomes** the datasource. That is why there is no
re-import: the file is the definition, and editing the datasource means
editing the file and pulling.

### 4. The password, on the far side

Three ways, in the order the server tries them:

1. **A local password**, set on the imported datasource's own page.
   Encrypted with AES-256-GCM under this project's key and never written
   back to the repository. This is the one you want for a personal second
   machine.
2. **The environment variable** `config.yaml` named. This is the one you
   want for a deployment, or a team where everybody has their own
   credential.
3. **`noPassword: true`** in the file, for a trust-auth cluster inside
   the checkout.

If none applies, the datasource is listed and not connectable, and the
message names the variable it wanted — rather than hiding a datasource
you thought you had imported.

## What this does not do

- **One repository holds one datasource.** `.datagripe/` is at the work
  tree root or it does not exist. Two datasources in one repository is
  not supported, and `docs/spec/git-datasources.md` names it as the first
  thing that would have to change.
- **There is no export-everything button.** Export config is per
  datasource, one press each.
- **An imported datasource is read-only in the form.** Its connection
  fields come from a committed file, so you change them by editing
  `.datagripe/config.yaml`. What stays yours are the password, `read
  only` and `show all schemas` — an imported repo you opened to look at
  production should not need a pull request to keep read-only on.
- **Push is never bundled into export**, and never automatic. It is
  always a separate, explicit press.
