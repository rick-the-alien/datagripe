# Brand assets

The shipped brand files — the ones that end up in a bundle, a manifest or
a page — live here and nowhere else. Everything under `apps/` and `site/`
that looks like one of these is a copy, kept honest by `check:brand`.

For the brand *system* — the palette, the type scale, the two mascot asset
sets and when each is allowed on screen — see [docs/brand/](../docs/brand).
That directory is the writing; this one is the files.

```
brand/
  app-icon/
    icon.svg                 the artwork, and the master everything else comes from
    icon.png                 256x256 — the desktop launcher icon
    icon-192.png             PWA, and the apple-touch-icon
    icon-512.png             PWA
    icon-maskable-512.png    PWA maskable — art inset on the brand dark
  mascot/
    *.svg                    the painted set, loaded by URL (MascotArt, site/style.css)
```

Source files that are not shipped — layered originals, references, working
sketches — belong beside the asset they produced, e.g. in `app-icon/`.
Nothing here is copied anywhere unless `scripts/sync-brand.ts` names it.

## Changing something

```bash
bun run brand:render   # only if app-icon/icon.svg changed: redraw the PNGs
bun run sync:brand     # copy into apps/ and site/
```

Then commit both the brand file and its copies. CI runs `bun run
check:brand` and fails if a copy has drifted, so a forgotten sync is
caught in the pull request rather than in a release.

`brand:render` needs `rsvg-convert` and ImageMagick. It is deliberately
not part of any build: the web build, the desktop build and the Pages
deploy would all have to grow a dependency on them to regenerate a file
that only changes when someone redraws the icon.

## Why the copies are tracked

Each consumer serves its own tree verbatim and has nowhere to put a build
step. The Pages workflow uploads `site/` as it stands — deliberately, so
that "there is nothing to build, and a build step would only be somewhere
for it to break" — and Vite serves `apps/web/public/` straight through in
dev. Tracked copies cost a few hundred kilobytes and cannot break a
deploy. Generating them at build time cannot cost anything and can break
every one of them.

## Known gaps

- **macOS and Windows app icons.** Electrobun wants an `icon.iconset`
  directory for macOS and has no Windows icon setting in 2.0.1, so both
  platforms still ship a generic icon. `icon.svg` is the source when that
  is picked up.
- **The maskable icon frames the artwork rather than bleeding it.** The
  drawing carries its own rounded-square container, so a maskable that
  filled the square would be a container inside a container. Insetting it
  on the brand dark is the safe reading, not necessarily the right one.
- **`apps/web/index.html` still uses `/mascot/oh-my.svg` as its favicon**,
  chosen while `icon.svg` was the old placeholder cylinder. It is now the
  real mark, so that link is worth revisiting.
