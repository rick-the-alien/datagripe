# site

The datagripe.com landing page. Plain HTML, CSS and one script — there
is nothing to build, so there is nothing to break in a build.

`tokens.css` and `icon.svg` are **copies** of `docs/brand/tokens.css` and
`apps/web/public/icon.svg`. Re-copy them when either changes; the site
deliberately does not import across the repo, because the deployed
artifact is just this folder.

## How it deploys

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on
every push to `main` that touches `site/`. There is no `gh-pages`
branch: Pages serves a workflow artifact.

One-time setup: **Settings → Pages → Source = "GitHub Actions"**.

## Custom domain

`CNAME` claims `datagripe.com`, which is only half of it — the DNS has
to point here too. For the apex domain, four A records:

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

Plus a CNAME for `www` → `rick-the-alien.github.io`. Once DNS resolves,
tick **Enforce HTTPS** in the Pages settings; the certificate can take a
few minutes to issue.

## Downloads

`download.js` asks the GitHub API for the latest release and rewrites
the button for the visitor's platform. It cannot use GitHub's fixed
`/releases/latest/download/<name>` redirect because the asset filenames
carry their version — which is worth keeping, since a file in a
downloads folder should say what it is.

The markup ships pointing at the releases page, so the page still works
with no JavaScript, a rate-limited API, or a failed request.
