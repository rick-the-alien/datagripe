# Datagripe — brand and interface system

**Version 3.** This is the implementation spec. `brand-system.html` renders the visual side; the mocks in `mocks/` are working prototypes of the interactions. `tokens.css` is drop-in.

Datagripe is an independent parody. See [Parody boundary](#parody-boundary).

---

## Contents

1. [Positioning](#positioning)
2. [Logo](#logo)
3. [Mascot](#mascot)
4. [Colour](#colour)
5. [Typography](#typography)
6. [Motion](#motion)
7. [Projects and the prompt](#projects-and-the-prompt)
8. [Sidebar](#sidebar)
9. [Table view and object view](#table-view-and-object-view)
10. [Danger zone](#danger-zone)
11. [Interface rules](#interface-rules)
12. [Voice](#voice)
13. [Attitude levels](#attitude-levels)
14. [Writing gripes](#writing-gripes)
15. [Parody boundary](#parody-boundary)
16. [Build order](#build-order)
17. [Open items](#open-items)

---

## Positioning

A database client that does its job perfectly and resents you the entire time.

A straight-faced developer tool with one twist: the linter has opinions and no manners. The chrome has to be credible enough that someone would work in it all day, because the joke only lands if the tool is real. **Comedy lives in the copy. It never lives in the layout.**

**Who it is for.** People who spend their working day in a database client and have strong opinions about it. They will notice if the syntax highlighting is wrong.

**What it must never be.** Zany. No comic fonts, no wacky illustrations. The mascot is deadpan. The humour is dry, specific, and technically correct.

---

## Logo

Three approved forms. There is no fourth.

**Primary lockup.** Mark left, wordmark right, optically centred on the wordmark's x-height.

**Wordmark alone.** Monospace medium at `-0.03em`. `Data` takes the foreground colour of its surface; `gripe` is always Gripe Green. The split is the punchline and is never inverted, evened out, or recoloured to match a client palette.

**Mark alone.** The cylinder with scowl. Favicons, app icons, avatars, anything under 40px wide.

| Spec | Value |
| --- | --- |
| Clear space | All sides, equal to the cap height of the D |
| Min width, lockup | 120px screen, 32mm print |
| Min width, wordmark | 84px |
| Min size, mark | 16px, hand-tuned asset |
| Backgrounds | Void, Panel, or pure white. Never a photo, gradient, or mid-tone. |

### Favicon

Features drop as the canvas shrinks:

- **64px** — silhouette, rim, eyes, brows, mouth
- **32px** — mouth removed
- **16px** — silhouette and the two brow strokes only

Ship `favicon.svg` plus hand-drawn 32×32 and 16×16 raster fallbacks. Never let the browser downscale the full mark; the brow strokes turn to mush and "grumpy" becomes "smudge".

### The `>` device

The prompt caret from the wordmark studies is adopted, but as **interface**, not as part of the logo. See [Projects and the prompt](#projects-and-the-prompt). The logo lockup itself never includes the caret or the cursor — those belong to the running application.

> **Open:** the display face used in the wordmark studies needs a licensing check for embedding. If it clears, use it for the wordmark only and keep IBM Plex Mono for the interface. Display face for the wordmark, workhorse mono for UI, is the normal and correct split.

---

## Mascot

It has no name and does not get one. It is the database. A name makes it a character, a character invites a backstory, and a backstory ends in merchandise and whimsy.

### Frequency is the design

You should be pleased to see it. That only holds if it is rare. A mascot that appears on every lint finding stops being funny within a day and makes the product feel like a toy to exactly the audience it needs to convince.

**Ship at tier 1. Tier 2 only once tier 1 has been lived with.**

| Tier | Appears in | Roughly |
| --- | --- | --- |
| **1 — chrome** | Favicon, about, splash, empty states, error pages, onboarding, marketing | Never during normal work |
| **2 — rare events** | Tier 1, plus first connection to a new project, destructive-action confirmations, milestones | Once a week at most |
| **3 — gripes panel** | Empty state only ("no gripes" gets faint approval). **Never per-gripe.** | — |

### Expressions

The in-app set is deliberately small. A larger illustrated library may exist for marketing, and the two are not the same asset set.

| Expression | Change from default | Used for |
| --- | --- | --- |
| scowl | the default | everywhere unless stated below |
| side-eye | pupils shifted, brows unchanged | warnings, slow query notices |
| eyes closed | brows flat, eyes as arcs | connecting, waiting |
| faint approval | one brow raised, mouth level | onboarding complete, empty gripes panel |

Never smiling, waving, wearing accessories, holding props, or in seasonal costume.

### Two asset sets, not one

This is the thing that kills mascot programmes if it is got wrong.

- **Painted set** — the rendered illustrations with highlights and gradients. Marketing, splash, docs, empty states. Raster. Not riggable and not intended to be.
- **Flat SVG set** — a simplified build for anything that animates in-app. Flat fills, no painted highlights, layered for rigging.

Trying to make one asset serve both jobs produces a mascot that is either too heavy to animate or too plain to sell.

### Rigging

The character is about twelve parts: body, rim, face group (brows, eyes, pupils, mouth), two two-bone arms, two two-bone legs, shadow. Trivially riggable once the flat SVG exists.

Runtime options, in order of increasing cost:

- **SVG + Web Animations API** — lightest, themeable via CSS custom properties, no dependency
- **Rive** — purpose-built, real state machines, worth it if reactions are event-driven and numerous
- **Sprite sheet** — cheapest if eight canned reactions is genuinely all that is needed

### The waiting game

An easter-egg mini-game is approved in principle, with one binding constraint: **it must not be triggered by a slow query.** A game that appears because the database is slow rewards the exact thing the product exists to complain about, and turns a performance problem into entertainment.

Trigger it by interaction instead — clicking the mascot in an empty state, or a key sequence. Then it is a treat someone found rather than a consolation prize for bad SQL.

---

## Colour

Four accents, one job each. Colour encodes meaning, so an accent used decoratively is a bug.

| Name | Hex | Role |
| --- | --- | --- |
| Gripe Green | `#00E599` | Primary brand. Mascot, wordmark split, healthy connection, positive values, local projects. |
| Focus Violet | `#8B5CF6` | Selection and focus. Active tab, selected row, keyboard focus, staging projects. **Never text.** |
| Snark Magenta | `#FF3EA5` | Keywords, the complaint itself, destructive actions, production projects. |
| Function Cyan | `#5EEAD4` | Functions in the tree, cylinder rim, inline code, analytics projects. |

### Neutrals

| Token | Hex | Use |
| --- | --- | --- |
| Void | `#0B0E14` | App background, editor canvas |
| Panel | `#0E1220` | Toolbars, sidebar, status bar, tab strip |
| Raised | `#161C29` | Selected rows, menus, popovers |
| Rule | `#212A3A` | Borders between regions |
| Rule soft | `#161C29` | Row dividers within a region |
| Ink | `#E2E8F0` | Primary text |
| Ink dim | `#9AA5B6` | Secondary text |
| Ink mute | `#6B7688` | Metadata, timestamps |
| Ink faint | `#3D4759` | Line numbers, disabled |

### Contrast on Void

| Colour | Ratio | Verdict |
| --- | --- | --- |
| `#00E599` | 11.2:1 | Any text size |
| `#5EEAD4` | 12.6:1 | Any text size |
| `#FF3EA5` | 5.9:1 | Body and above, not 11px |
| `#8B5CF6` | 3.7:1 | **Fails.** Borders and fills only. |
| `#A78BFA` | 6.3:1 | The violet to use for text |

### Deep cyan

`#5EEAD4` is pale by construction — high lightness, moderate chroma — so it reads softer than the other three in motion. Use `#14D9C4` wherever cyan must hold its own at speed. Keep `#5EEAD4` for static interface use where it carries small text.

### Accessibility

All four accents sit at similar lightness, so **colour alone never distinguishes two states**. Every severity, status, or category coded by colour carries a second cue: an icon, a dash pattern, or a text label. This is a hard requirement, not a nicety — a user with a colour vision deficiency must be able to read the gripes panel and tell a production project from a staging one.

---

## Typography

| Role | Size / line height | Family |
| --- | --- | --- |
| display | 60 / 1.02, weight 700 | Space Grotesk |
| heading | 27 / 1.25, weight 500 | Space Grotesk |
| body | 16 / 1.65, weight 400 | IBM Plex Sans |
| ui label | 13 / 1.4, weight 400 | IBM Plex Sans |
| gripe text | 14 / 1.5, weight 400 | IBM Plex Sans |
| editor | 13 / 1.8, weight 400 | IBM Plex Mono |
| tree, grid | 12.5 / 1.5, weight 400 | IBM Plex Mono |
| metadata | 11.5 / 1.4, weight 400 | IBM Plex Mono |

Space Grotesk is website only and never appears inside the application. Weights 400 and 500 only in the UI. **Sentence case everywhere** including buttons, menus and tabs. No all-caps labels anywhere.

Database object names, types, values, and anything the user could paste into a query are always monospace. Prose about those things is sans.

---

## Motion

A query takes 100ms or twenty minutes and the bar cannot know which, so it stops implying duration entirely. The brand rule at the top edge of the window is also the activity indicator: static while idle, drifting while a statement executes. Nothing starts, arrives, or completes. It is weather, not progress.

### Three invariants

Breaking any of these is a visible regression, and each was a bug found the hard way.

**1. The colour cycle is a palindrome.** Green, cyan, violet, magenta, violet, cyan, green. It ends on the colour it starts on, so tiles join on an exact match. A linear ramp puts magenta directly against green at the tile boundary — two stops at the same position, a hard discontinuity that slides past on every cycle like a join in a conveyor belt.

**2. Plateaus, not pure blends.** Each colour holds a flat run at its true hex. Without plateaus you only ever see blends and never the palette itself. Green and magenta appear once per half-cycle and cyan and violet twice, so green and magenta get double-width plateaus; all four end up at exactly 15% of the tile. Plateau share of 60% is the recommendation — above 75% the bands become countable and a perceptible rhythm returns, which is a loop by another name.

**3. Colour layers never blend with each other.** One saturated colour layer. The other two are neutral dark waves using `multiply`. `screen` and other additive modes can only move a pixel toward white, so overlapping hues bleach — that is what turns the bar pastel. **Any future layer introducing a second hue re-opens this regardless of blend mode.**

### Timing

| Layer | Period | Mode |
| --- | --- | --- |
| Colour | 17s | normal |
| Dark wave | 11s (reversed direction) | multiply |
| Counter wave | 23s | multiply |

Those periods share no common factor, so the combined pattern does not repeat for roughly 72 minutes. Container carries `saturate(1.22)` and a ±7° hue oscillation at 31s.

Interpolation is `in oklab` behind `@supports`, with an sRGB ramp as fallback. sRGB drags green-to-violet through a desaturated grey at the midpoint.

### Long queries calm down

Playback rate eases from 1.0 to 0.4 across the first ten minutes. Use the Web Animations API `playbackRate` — rewriting `animation-duration` on a running animation recomputes its position and the bar visibly jumps. Twenty minutes of increasingly frantic animation is a hostage situation; the correct posture is unbothered.

### Rules

- Never run two indicators at once.
- Hold idle for the first 200ms so fast queries do not flash.
- Never speed it up to signal urgency.
- Marketing site uses the **static** rule. Motion means the database is busy, and that meaning only survives if it is never spent on decoration.
- Under `prefers-reduced-motion` everything collapses to the static gradient. The brand edge stays; only the weather stops.

Full CSS in `tokens.css`. Live demo in `mocks/activity-bar.html`.

### Interface motion

Everything that is not the activity bar: 120ms ease-out, and only to confirm an action the user took. Nothing animates on load, nothing pulses, nothing glows. Mascot animations are the sole other exception and are governed by the frequency tiers above.

---

## Projects and the prompt

**A project is the unit of context. Exactly one is active, and switching swaps everything.**

Connections, saved files, query history, snippets, and the attitude level all belong to a project rather than to the application. There is no global connection list and no way to have two projects open at once, because the entire class of accidents this design prevents comes from ambiguity about which environment you are pointed at.

### The prompt

The switcher is a shell prompt, not a control. No border, no background, no left highlight — it is the current context and needs no chrome to say so.

```
>Datagripe:wallet-prod_
```

| Part | Colour | Behaviour |
| --- | --- | --- |
| `>` | Snark Magenta | Fixed |
| `Data` | Ink | Fixed |
| `gripe` | Gripe Green | Fixed |
| `:` | Ink faint | Fixed |
| `wallet-prod` | **project accent** | Underlines on hover and focus. Click opens the switcher. |
| `_` | project accent | Blinks when idle, **solid while a query runs** |

`>Datagripe` is stable brand and never mutates. Only the path segment and the cursor carry project identity, which keeps the lockup constant and stops a long project name dragging the wordmark across the toolbar.

The solid cursor during execution is a second, quieter activity signal that does not compete with the bar.

### Colour is the safety mechanism

Every project carries one of the four accents. It appears on the prompt path, the cursor, and the connection indicator in the status bar. **Production is magenta — the only thing in the interface that is magenta and permanent**, so peripheral vision learns it fast.

| Class | Colour | Meaning |
| --- | --- | --- |
| production | Snark Magenta | Live data. Destructive statements require confirmation. |
| staging | Focus Violet | Shared, disposable, safe to break. |
| local | Gripe Green | Yours alone. No guards. |
| analytics | Function Cyan | Read-only replicas. Write statements blocked outright. |

The class is not decorative — it gates behaviour. See [Danger zone](#danger-zone).

### Scope

**Belongs to a project:** connections and credentials, open editors, saved files, query history, snippets, saved result views, attitude level, colour class.

**Global:** theme, font size, keymap, licence, update channel.

Switching closes open editors, tears down connections, and reopens the target project's session. It is a context switch, not a filter, and the interface says so rather than pretending it is instant.

---

## Sidebar

### Structure

Five levels of nesting do not fit in a sidebar. The tree carries three, and the other two are handled elsewhere.

```
┌─────────────────────────────┐
│ wallet-prod / public     ▾  │  breadcrumb header — datasource + schema
├─────────────────────────────┤
│ filter objects…             │  always present
├─────────────────────────────┤
│ ▸ tables                 7  │  level 1 — category
│   ▤ payments             ⊞  │  level 2 — object
│   ▤ users                   │
│   ▤ payouts                 │
│ ▸ views                  2  │
│   ◫ v_pending               │
│ ▸ functions              4  │
│   ƒ fn_settle               │
│ ▸ sequences              0  │
│     no sequences            │  synthetic empty row
│ ▸ materialized views        │
│     loading…                │  distinct loading row
└─────────────────────────────┘
```

**Datasource and schema are a breadcrumb header, not tree rows.** Switching schema is a dropdown on that header. This buys back two levels of indentation exactly where object names are longest.

**Fields are not in the tree.** The tree navigates *between* objects; fields are the *contents* of one object. Putting them in the tree costs a level of indentation, pushes every sibling table below the fold when one table is expanded, and duplicates the object view's columns tab. Field access is covered by the hover popover and the object view.

### Chevrons

The type icon swaps to a chevron on hover **and on keyboard focus**. Content visibility is the state signal — an expanded node is obviously expanded because you can see its children.

The two cases where that fails both get explicit rows:

- **Empty** — a synthetic `no <category>` row in Ink faint italic
- **Loading** — a distinct `loading…` row in Violet text

A node that is expanded but still fetching must not look identical to an empty one.

### Field popover

Hover a table or view for **450ms** and a popover appears to the right listing column names and types. This is for quick lookups while writing a query, so you do not have to open anything.

- Names left, types right in Function Cyan, primary key in Snark Magenta
- Dismiss on mouseleave, on `Escape`, and on `mousedown` — the last one so it does not fight drag-to-editor
- Suppressed while a context menu is open
- Reposition upward if it would overflow the pane bottom

> **Open:** hover has no keyboard equivalent. Proposal — single click on an already-selected row opens the popover, which also gives that currently-dead interaction a job.

### Selection and opening

| Action | Result |
| --- | --- |
| Single click | Select only. No tab opens. |
| Ctrl / Cmd click | Add to multi-selection (objects only) |
| Double click | Open **table view** |
| Click `⊞` (hover-revealed, far right) | Open **object view** |
| Right click | Context menu |
| Middle click | Open table view in a background tab |

Single click never opens a tab. Double-click gating exists so clicking around the tree does not fill the tab bar.

### Context menu

```
view rows                  dbl click
──────────────────────────
columns
indexes
constraints
triggers
grants
statistics
ddl
──────────────────────────
copy name
──────────────────────────
danger zone…
```

The structural entries **deep-link** — choosing `indexes` opens the object view already on the indexes tab, not on columns. Since the menu mirrors the tab list anyway, making it navigate is free and it is the faster path for the case the menu exists to serve.

---

## Table view and object view

Two openable surfaces, deliberately different weights. They never compete for space and neither contains the other.

### Table view — the data

Opened by double click, middle click, or `view rows`. Gets the entire pane.

- **One line of chrome at the top**: refresh, a `where …` filter input, a row limit selector, export, overflow. That is all.
- Default limit **100 rows**, configurable. The selector is a menu, not a text field.
- Row numbers in Ink faint, primary key in Snark Magenta, numerics right-aligned and coloured, everything else neutral
- Sticky header row
- Footer states `100 of 41,203,882 rows` and the edit state

Everything else is rows. Real estate goes to data.

### Object view — the structure

Opened by the `⊞` affordance or the context menu. Tabs across the top:

`columns · indexes · constraints · triggers · grants · statistics · ddl` … `danger zone`

**There is no data tab.** Data is the table view's job. This is what lets both surfaces be generous with space.

The object view is the natural home for incremental feature work — partitions, dependencies, policies, comments, bloat estimates, and gripes scoped to this object all slot in as tabs without redesigning anything.

### Tab identity

A table can have both views open at once, so the tab strip must distinguish them:

| View | Glyph | Label |
| --- | --- | --- |
| Table view | `▤` Gripe Green | `payments` |
| Object view | `⊞` Function Cyan | `payments · structure` |

Without the glyph and suffix, two tabs both reading `payments` is a coin flip.

---

## Danger zone

The last tab in the object view, pushed to the right edge behind a divider, rendered in a dimmed magenta until hovered.

### Gating

Every action is collapsed by default:

1. **Reveal** — a click expands the action
2. **Type the object name** — free-text confirmation, not a checkbox
3. **Execute** — the button enables only on an exact match

Typing the name is the point. It means muscle memory cannot fire a destructive action, and it scales with the risk rather than adding a modal everyone learns to dismiss.

### Project class gating

The colour class already knows what kind of environment this is, so it may as well do a second job:

| Class | Danger zone behaviour |
| --- | --- |
| local | Standard gating |
| staging | Standard gating |
| production | Confirmation requires the **project** name, not the table name |
| analytics | Tab renders **disabled** with the reason stated — read-only replica |

### Contents

Initially `truncate` and `drop`. Each states its real consequences in the panel header — row counts, what is kept, what cascades, and that nothing here is undoable.

---

## Interface rules

| Spec | Value |
| --- | --- |
| Corner radius | 10 panels and cards, 6 inputs and buttons, 10 pill on counts, **0 on anything with a single-sided accent border** |
| Borders | 1px Rule between regions, 1px Rule soft between rows, 2px accent on tabs, 3px accent on gripe rows |
| Spacing | 4px base. Component padding 6, 9, 12, 18. Section rhythm 24, 40, 56 |
| Elevation | **No shadows.** Depth is a background step: Void → Panel → Raised |
| Motion | 120ms ease-out, only to confirm a user action |

**Tree colouring.** Object categories carry the accent (`tables` violet, `views` magenta, `functions` cyan) with counts beside them; individual objects stay Ink dim. Colouring leaf rows turns a four-hundred-table schema into confetti.

**Selection.** A 2px violet left border and a step up to Raised. Never a filled accent background — a filled row competes with the syntax colours beside it.

**Gripe rows.** Severity is a 3px left border with the background tinted to roughly 4% of that accent over Void. Square corners, since the border is single-sided. Each row carries a severity icon so meaning survives without colour.

**Results grid.** Right-align numerics and colour only the value column. Everything else stays neutral.

**Splitters.** Draggable between sidebar and main, and between editor and results. The tab system supports splits, so the object view can also be placed beside the editor or below it — the placement is the user's, and the spec only fixes that it opens as a tab.

---

## Voice

Dry, specific, technically correct, and quite rude. A senior engineer who has reviewed this query before and is tired.

The tension that makes the product work is that the criticism is always accurate. A gripe that is merely rude is noise and users disable it within a week. A gripe that is correct and rude is a feature they screenshot into the team channel. Every complaint must survive being read by someone who then goes and checks the query plan.

**It is:** deadpan, specific, brief, right, sweary when the situation has earned it, occasionally resigned.

**It is not:** cruel, personal, or edgy for its own sake. It criticises the query, never the person who wrote it.

### Everything that is not a gripe

Written plainly, in a normal product voice. Errors say what happened and what to do. Empty states invite an action. Settings labels are boring on purpose. If the whole interface is sarcastic then nothing is, and the gripes stop landing.

> ✅ Couldn't reach wallet-prod. Check the host and port.
>
> ❌ Well, that didn't work. Have you tried turning it off and on again?

---

## Attitude levels

Snark is configurable, and the levels are Postgres severities because of course they are. Set per project, so a local sandbox can be feral while the shared production project stays presentable. Also a session setting, so it can be dropped before a screen share without opening preferences:

```sql
set datagripe.attitude = 'notice';
```

| Level | Behaviour | Use |
| --- | --- | --- |
| `notice` | No profanity. Dry and still critical. | Screen shares, workshops, conference demos, anyone who would rather not. |
| `warning` | **Default.** Quirky, blunt, swears when it is earned. | Normal working use. |
| `fatal` | Unfiltered. Swears freely. | Local projects and people who opted in. |
| `panic` | Deliberately excessive. Shipped as a joke. | Nothing. It is exhausting by design and that is the point. |

**The technical content never changes between levels — only the register.** Attitude is a presentation layer over a fixed set of correct observations, never a different analysis. Implementation follows: one finding, four strings, selected at render.

`warning` is the default and stays the default. `panic` can never be the default, cannot be set organisation-wide, and resets on upgrade. A joke that cannot be escaped is not a joke.

### The same finding at each level

Rule: `select *` across 41M rows with no index on `status`.

| Level | Text |
| --- | --- |
| `notice` | Unqualified `select *` across 41M rows, and `status` has no index. |
| `warning` | `select *` across 41M rows and sod all in the way of an index. This is a denial of service with extra steps. |
| `fatal` | 41M rows, `select *`, and no bloody index on `status`. Kill it before on-call works out it was you. |
| `panic` | Forty-one million rows. No index. `select *`. What in the absolute hell is this. Cancel it. Cancel it now. |

Rule: join with no condition.

| Level | Text |
| --- | --- |
| `notice` | This join has no condition. That is a cross product. |
| `warning` | This join has no condition. I'll allow it. I won't forget it. |
| `fatal` | No join condition. You've asked for every row times every row. Absolute state of this. |
| `panic` | NO JOIN CONDITION. Every row. Times every row. I want you to sit and think about what that number is. |

---

## Writing gripes

The highest-risk surface in the product.

**Structure.** One sentence, or two short ones. Under 90 characters at `notice` and `warning`. Name the actual construct. Attach a factual footer with severity, line, and rule id so the complaint is auditable.

| Rule | Why |
| --- | --- |
| Be correct | A wrong gripe destroys trust in every other gripe. |
| Be specific | Name the table, the column, the row count. Generic snark is filler. |
| Never personal | Target the query. Never the author's competence, effort, or intelligence. |
| No slurs, ever | Nothing touching race, gender, sexuality, disability or religion at any level, including `panic`. Swearing at a query is funny; punching downward is not, and it is the one thing that would follow the product around. |
| Profanity is earned | It lands because it is rare and proportionate. A gripe that swears at a missing semicolon has spent the currency for nothing. |
| No repetition | The same rule firing twice uses the same wording. Never generate variants to seem clever. |
| Always dismissible | Per rule and per file, at every attitude level. |

### Calibration

> ✅ This join has no condition. I'll allow it. I won't forget it.
> — correct, specific, dry, one beat of personality
>
> ❌ lol did you even look at this before running it??
> — personal, unspecific, no technical content, wrong register
>
> ❌ Hmm, this query might be a little slow, maybe?
> — hedged into uselessness. If the tool is not sure, it says nothing.

---

## Parody boundary

Datagripe is an independent parody. The name, the mascot, the wordmark and this entire visual system are original work and must stay that way.

Neon accents on a dark interface are a broad convention across developer tooling and are not owned by anyone. **Composition is different.** Do not reproduce, adapt, or evoke another vendor's logo geometry — overlapping offset squares, knocked-out two-letter monograms, or any recognisable mark lockup. Do not use another company's screenshots, icon set, or brand assets in marketing.

Every public surface carries a footer disclaimer stating that Datagripe is not affiliated with, endorsed by, or connected to any other software vendor. One line, and it removes the only argument worth worrying about.

---

## Build order

Suggested sequence, chosen so each stage is usable and nothing is blocked on an open item.

**1. Tokens and shell.** `tokens.css`, window chrome, activity bar, prompt switcher, status bar. The bar and the prompt are the two things that make it feel like the product rather than a generic client, and both are cheap.

**2. Projects.** Project model, switcher, colour classes, context teardown on switch. Everything downstream assumes a project exists, and the colour class gates behaviour later.

**3. Sidebar.** Breadcrumb header, filter, three-level tree, hover chevrons, empty and loading rows. No popover yet.

**4. Table view.** Double click, filter line, limit selector, grid. This is the first thing that makes the tool genuinely useful.

**5. Object view.** Tabs for columns, indexes, constraints, triggers, grants, statistics, ddl. Context menu with deep-links.

**6. Field popover.** Needs the tree and the object view to exist first so it does not duplicate work.

**7. Danger zone.** Including project-class gating. Deliberately late — it is the one surface where a bug is destructive.

**8. Gripes engine.** Rule catalogue, severity model, attitude levels, dismissal. The catalogue is the actual product and deserves its own design pass.

**9. Mascot, tier 1.** Favicon, empty states, onboarding. Flat SVG set only.

### Acceptance checks worth automating

- Activity bar: first and last gradient stop are the same colour, and every stop has a twin at +50%
- No `mix-blend-mode` other than `multiply` on any activity bar layer
- No colour token used for text where its contrast on Void is below 4.5:1 (this catches raw `#8B5CF6` on text)
- Every colour-coded state has a non-colour cue in the same component
- `prefers-reduced-motion` removes all `animation` from the bar and the cursor
- No `text-transform: uppercase` anywhere
- Every destructive action requires a typed confirmation

---

## Open items

Genuinely undecided. Listed so they are not mistaken for omissions.

| Item | Notes |
| --- | --- |
| **Light theme** | The system is dark-only. All four neons need re-picking against white; none survive the move unchanged. |
| **Gripe rule catalogue** | This spec says how to write a gripe, not which rules ship. That catalogue is the actual product. |
| **Keyboard path to the field popover** | Hover has no keyboard equivalent. Proposal: single click on an already-selected row. |
| **Multi-select purpose** | Ctrl-click works. Export, join skeleton, structure diff — pick one before the context menu grows a section that does nothing. |
| **Popover vs drag** | If tables can be dragged into the editor, the popover must suppress on `mousedown`. Stubbed in the mock. |
| **Tree at scale** | Filter behaviour with 400+ objects: does it filter in place, flatten results, or both? |
| **Wordmark typeface licensing** | The display face from the wordmark studies needs an embedding licence check. |
| **Attitude and localisation** | Profanity does not translate at consistent strength. Each locale needs its own calibration, not a translated string table. |

---

*Version 3. Changes to colour, type, the motion invariants, or the gripe rules go through review. Everything else is yours.*
