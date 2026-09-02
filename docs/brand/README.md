# Datagripe — brand and UI bundle

Version 3. Everything needed to build the thing.

Datagripe is a database client that does its job perfectly and resents you the entire time. It is an independent parody — see the parody boundary section of the spec before doing anything with marketing.

## What is in here

| File | What it is |
| --- | --- |
| **`brand-system.md`** | The spec. Start here. Colour, type, motion, projects, sidebar, both object views, danger zone, voice, attitude levels, build order, open items. |
| `brand-system.html` | The visual companion. Live swatches, logo and favicon at real sizes, running activity bar, the prompt switcher. Open in a browser. |
| `tokens.css` | Drop-in design tokens plus the activity bar and prompt implementations. Commented with the invariants that must not be broken. |
| `mocks/tree-interactions.html` | **The important one.** Working prototype of the sidebar: hover popover, `⊞` object view, double-click table view, context menu, multi-select, danger zone gating. |
| `mocks/datasource-selector.html` | Datasource and schema breadcrumb, engine-aware namespace segment, new-datasource tab. |
| `mocks/document-target.html` | Per-document target binding, the chip group, split panes on two datasources, unset and broken states. |
| `mocks/results-tab.html` | Results as an ordinary tab in any split position, gutter run buttons, table/history modes, joined export group. Supersedes the tab-strip chip group. |
| `mocks/scrollbars.html` | Scrollbar treatment for the tree and the results grid, plus the annotation rail. |
| `mocks/drilldown.html` | Why the object view is an editor tab rather than an inspector or bottom panel. Switchable, with the tree-depth toggle that shows the overlap. |
| `mocks/activity-bar.html` | The activity bar in isolation, with saturation and wave-depth controls, and a before/after of the blend-mode bug. |

## For the coding agent

Read `brand-system.md` end to end first. Then:

1. `tokens.css` is authoritative for values. Do not re-derive hexes from the mocks.
2. `mocks/tree-interactions.html` is authoritative for interaction behaviour. It is a prototype, not production code — read it for *what happens when*, not for structure.
3. The mocks are hand-written vanilla JS with inline styles. Do not port them directly.
4. **Build order** is at the end of the spec and is chosen so nothing is blocked on an open item.
5. **Open items** are genuinely undecided. Do not resolve them silently — raise them.

## Three things that are easy to break

These were each found the hard way and are the most likely regressions.

**The activity bar gradient must be a palindrome.** First stop colour equals last stop colour, and every stop has a twin at +50%. Otherwise a hard seam slides past every 17 seconds.

**No additive blend modes on the activity bar.** `screen` and friends push overlapping hues toward white and turn the whole thing pastel. Colour layers never blend with each other; the modulation layers are neutral and use `multiply`.

**`#8B5CF6` never carries text.** It is 3.7:1 on the void background and fails contrast. Use `#A78BFA` for violet text; the raw violet is for borders and fills only.

## Not included

- Icon set — spec assumes a line icon family, not chosen
- Light theme — dark only, listed as an open item
- The gripe rule catalogue — how to write one is specified, which ones ship is not
- Mascot assets — the character and its usage rules are specified, the flat SVG rig has not been drawn
