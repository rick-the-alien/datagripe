# site

The datagripe.com landing page. Plain HTML, CSS and one script — there
is nothing to build, so there is nothing to break in a build.

`tokens.css`, `icon.svg` and `mascot/` are **copies** of
`docs/brand/tokens.css`, `apps/web/public/icon.svg` and
`apps/web/public/mascot/`. Re-copy them when any of those change; the
site deliberately does not import across the repo, because the deployed
artifact is just this folder.

## How it deploys

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on
every push to `main` that touches `site/`. There is no `gh-pages`
branch: Pages serves a workflow artifact.

One-time setup: **Settings → Pages → Source = "GitHub Actions"**.

## Custom domain

`CNAME` does **not** claim the domain. For Actions-based Pages the file
only preserves a domain that is already set, so all three of these are
needed and in this order:

1. DNS pointing at GitHub (below).
2. The domain set on the Pages site itself —
   `gh api -X PUT repos/OWNER/REPO/pages -f cname=datagripe.com`, or
   Settings → Pages → Custom domain.
3. A **re-deploy**. The domain does not bind to the existing
   deployment; until the workflow runs again, GitHub answers "Site not
   found" for a domain it does not yet associate with this repo.

Skipping (2) and (3) looks exactly like broken DNS, which is the wrong
place to go looking.

For the apex domain, four A records:

```
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

and, if the registrar supports AAAA:

```
2606:50c0:8000::153
2606:50c0:8001::153
2606:50c0:8002::153
2606:50c0:8003::153
```

Plus a CNAME for `www` → `rick-the-alien.github.io`, which GitHub
redirects to the apex. Then tick **Enforce HTTPS** (or
`-F https_enforced=true`); the certificate is usually issued within
minutes of the domain verifying, and enforcement cannot be set before
it exists.

## Downloads

`download.js` asks the GitHub API for the latest release and rewrites
the button for the visitor's platform. It cannot use GitHub's fixed
`/releases/latest/download/<name>` redirect because the asset filenames
carry their version — which is worth keeping, since a file in a
downloads folder should say what it is.

The markup ships pointing at the releases page, so the page still works
with no JavaScript, a rate-limited API, or a failed request.
