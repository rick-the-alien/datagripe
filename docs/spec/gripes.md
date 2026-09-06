# Spec — Gripes engine

**Status:** draft — nothing here is implemented
**Phase:** 11 (planned)
**Supersedes:** nothing (implements `docs/brand/brand-system.md` "Voice",
"Attitude levels", "Writing gripes", and the tier-3 mascot rule)

> This is a design, not a description. The only gripes code that exists
> today is the panel's empty state and the attitude selector, both marked
> MOCK. **Which rules ship is deliberately still open** — the brand spec
> calls the catalogue "the actual product" and reserves it for its own
> pass, and this spec does not pre-empt that. What it fixes is the
> machinery the catalogue will sit in.

## Goal

DataGripe notices things about your query and your schema, and says so —
accurately, specifically, and rudely. A gripe is a finding with a stable
rule id, a severity, a location, and a set of facts, rendered as one
sentence whose register depends on the project's attitude level.

The product thesis is a single sentence from the brand spec, and every
decision below follows from it:

> A gripe that is merely rude is noise and users disable it within a
> week. A gripe that is correct and rude is a feature they screenshot
> into the team channel.

So correctness outranks coverage, and silence outranks a guess.

## Non-goals

- **A general SQL style linter.** sqlfluff exists. A gripe earns its
  place by knowing something about *this* database — the row count, the
  missing index, the column that is nullable in practice. A finding
  derivable from the query text alone, with no reference to the schema
  or the cost, is usually a lint rule and belongs to a formatter.
- **Generated wording.** No LLM, no template shuffling, no synonym
  rotation. The brand spec is explicit: "The same rule firing twice uses
  the same wording. Never generate variants to seem clever." Four fixed
  strings per rule, written by a human, reviewed like copy.
- **Blocking anything.** A gripe never prevents a run, never gates a
  save, never fails a build. It is an opinion held loudly.
- **Auto-fix.** Suggesting `create index` text to copy is in scope
  later; editing the user's SQL is not.
- **Scoring.** No grade, no "query health 62%". A number invites gaming
  and averages away the one blocker that mattered.

## Design

### The shape of a rule

A rule is a pure function. It declares what it needs; the runner gives
it exactly that and nothing else.

```ts
interface Rule {
  /** Stable, namespaced, greppable: `<subject>.<problem>`. */
  id: string;                       // "index.missing"
  severity: "blocker" | "warning" | "style";
  /** What this rule needs to decide. The runner only calls rules whose
   *  inputs it can supply. */
  inputs: RuleInput[];              // ["statement", "schema"]
  /** Returns nothing when it cannot tell. Never a hedge. */
  evaluate(context: GripeContext): Finding[];
}

interface Finding {
  ruleId: string;
  severity: Severity;
  /** Where to point: a document range, an object, or a result set. */
  at: GripeLocation;
  /** Named values the wording interpolates. Never pre-formatted prose. */
  facts: Record<string, string | number>;
}
```

Two properties matter more than the types:

**A rule that cannot tell returns nothing.** The third calibration
example in the brand spec — *"Hmm, this query might be a little slow,
maybe?"* — is rejected for being "hedged into uselessness. If the tool is
not sure, it says nothing." That is a hard property, not a style note: a
rule needing the schema must stay silent when the schema is not cached,
rather than firing on a guess.

**A finding carries facts, not sentences.** `{ rows: 41203882, column:
"status" }`, not `"41M rows and no index on status"`. This is what makes
attitude a presentation layer rather than four parallel analyses.

### Findings are analysis; wording is presentation

The brand spec fixes this: "The technical content never changes between
levels — only the register. Attitude is a presentation layer over a
fixed set of correct observations, never a different analysis.
Implementation follows: one finding, four strings, selected at render."

So the split is:

| Stage | Produces | Depends on attitude |
| --- | --- | --- |
| Evaluate | `Finding` — rule id, severity, location, facts | no |
| Render | one sentence | yes |

Consequences worth naming:

- Changing the attitude level **re-renders**; it never re-analyses. The
  dropdown is instant and cannot change what was found.
- The server never sends prose. It would have to know the reader's
  attitude, and attitude is a per-session setting that changes without
  any new analysis.
- A gripe is auditable: the footer carries `severity · rule id · line`,
  and the rule id is the same string at every level and in every locale.

### Where the code lives

A new `packages/gripes`, pure, no I/O — the same shape as
`packages/sql-tools`:

```
packages/gripes/
  src/
    rules/            one file per rule, each a pure function + its tests
    catalogue.ts      the rule registry
    messages.ts       ruleId → { notice, warning, fatal, panic } templates
    render.ts         Finding + attitude → string
    runner.ts         given available inputs, run the applicable rules
```

Both the server and the web app import it: the server to evaluate rules
needing a connection, the client to evaluate rules over things it
already holds and to render every finding it displays.

### Where rules run, and why it is split

A rule's `inputs` decide this. Nothing else does.

| Input | Available to | Notes |
| --- | --- | --- |
| `statement` | client, server | the statement under the cursor, via sql-tools |
| `schema` | client, server | the client's completion catalog; the server's introspection |
| `object` | client | an `object.describe` result the object view already has |
| `execution` | server | row count, elapsed, truncation, affected rows |
| `plan` | server | `EXPLAIN` output — opt-in, see Open questions |

Static and structural rules run **in the client**: their inputs are
already in memory, so findings appear as you type with no round trip.
Execution and plan rules run **in the server**, which is where the
connection is, and arrive as part of the execution's event stream.

This is not two engines. It is one pure catalogue and two runners, and a
rule does not know or care which one called it.

### Severity, and why there are three

Three, because `tokens.css` defines exactly three and the brand spec's
gripe-row treatment is built on them:

| Severity | Token | Means |
| --- | --- | --- |
| `blocker` | `--dg-sev-blocker` (magenta) | this will hurt: a cross product, a full scan of a large table, a missing index behind a hot filter |
| `warning` | `--dg-sev-warning` (violet) | this is probably wrong: a nullable column compared with `=`, an unbounded `select *` |
| `style` | `--dg-sev-style` (green) | this is untidy and cheap to fix |

Severity is **how bad the finding is**. Attitude is **how rudely it is
phrased**. They are independent: a `style` finding at `fatal` swears
about something trivial, which is exactly the failure mode the brand
spec warns about — "A gripe that swears at a missing semicolon has spent
the currency for nothing." So the message catalogue is where that gets
controlled, per rule, by the person writing the strings. The engine does
not couple them.

### Presentation

Per the interface rules: a 3px severity border on the left, the
background tinted to roughly 4% of that accent over Void, square
corners because the border is single-sided, and **a severity cue that is
not colour** — a hard requirement, since all four accents sit at similar
lightness and someone with a colour vision deficiency must still be able
to read the panel.

Five surfaces, in descending order of how often you see them:

1. **Editor glyph margin and squiggle.** The mechanism already exists:
   `statementMarkers` renders per-statement glyph decorations for
   execution outcomes. Gripes reuse it with severity colours.
2. **Gripes panel.** The list, grouped by document then severity.
   Clicking a row reveals its location. This is the surface that already
   exists as a mock, including the attitude selector.
3. **Object view.** The brand spec puts object-scoped gripes here, and
   the tree-interactions mock shows the shape: an annotation block above
   the relevant tab's table — *"No index on `status`, which four of your
   five slowest queries filter on"* with a `blocker · index · missing`
   footer. Structural rules annotate the tab their subject lives in.
4. **Annotation rail.** From the scrollbars mock: marks beside the
   vertical scrollbar showing where findings are in the *whole*
   document, not just the visible window. Capped — "a rail with two
   hundred marks is a gradient, not a map. Cluster nearby marks into one
   and stop drawing past roughly forty."
5. **Status bar.** A count, which is already there reading "no gripes".

**The mascot appears on none of them.** Tier 3 is "empty state only
(`no gripes` gets faint approval). **Never per-gripe.**" A mascot on
every finding stops being funny within a day.

### Attitude levels

Four, from the brand spec, and they are Postgres severities on purpose:
`notice`, `warning` (default), `fatal`, `panic`.

Resolution order, first hit wins:

1. Session override — `set datagripe.attitude = 'notice'`, honoured as a
   real statement in the editor so it can be dropped before a screen
   share without opening settings. Lives for the session.
2. Project setting.
3. `warning`.

Three constraints on `panic`, all from the brand spec and all
implementable rather than aspirational:

- It can never be the default.
- It cannot be set for an organisation — only by the person reading it,
  for their own session or their own project.
- **It resets on upgrade.** Store the app version alongside the setting;
  if the version has changed and the level is `panic`, drop to
  `warning`. "A joke that cannot be escaped is not a joke."

**Blocked on the same thing the danger zone is.** Attitude and project
class both live in `apps/web/src/stores/branding.ts` in `localStorage`,
marked MOCK. A per-project attitude that the server does not know is a
per-browser attitude. Promoting both to the workspace model is one
migration and unblocks both features — see `docs/spec/object-view.md`
"Danger zone".

### Dismissal

"Always dismissible. Per rule and per file, at every attitude level."

Three scopes, coarsest last:

| Scope | Key | Means |
| --- | --- | --- |
| occurrence | rule id + location | not here |
| target | rule id + document or object | not in this file |
| project | rule id | never, in this project |

Stored server-side per workspace so a dismissal survives a browser and
is visible to the team. Two consequences to decide rather than discover
(see Open questions): a dismissal is currently proposed as **team-wide**,
because a schema finding is a team fact; and a scratchpad's dismissal
would reference a document id the server does not otherwise know, which
is harmless but worth noting.

Dismissal is never silent. The panel keeps a count of what is hidden and
a way to bring it back, or the feature becomes a way to make the tool
lie quietly.

### Rule ids are a public contract

A rule id appears in the gripe footer, in dismissal rows, and in
whatever anyone greps their logs for. Renaming one silently un-dismisses
it for every user. So: ids are stable, and a rule that changes meaning
gets a new id rather than new behaviour under the old one.

Format is `<subject>.<problem>`, lower-kebab: `join.no-condition`,
`index.missing`, `table.no-primary-key`, `select.unqualified-star`,
`routine.volatile-but-readonly`.

### Candidate rules — not the catalogue

**These are examples of the shape, not a shipping list.** The brand spec
reserves the catalogue, and the reserved decision is which of these (and
what else) earns a place, at what severity, with what wording.

| Candidate id | Inputs | Sketch |
| --- | --- | --- |
| `join.no-condition` | statement | a join with no `on` or `using` — the brand spec's worked example |
| `select.unqualified-star` | statement, schema | `select *` against a relation over some row threshold |
| `index.missing` | statement, schema | a filtered column with no index on a relation over some row threshold |
| `table.no-primary-key` | object | a base table with no primary key; the table view already knows and says so |
| `column.nullable-equality` | statement, schema | `=` against a nullable column, which silently drops nulls |
| `routine.volatile-but-readonly` | object | a routine marked `volatile` whose body only reads |
| `routine.definer-no-search-path` | object | `security definer` with no `search_path` set — a real escalation risk |
| `index.duplicate` | object | an index whose leading columns are another index's prefix |
| `execution.truncated` | execution | the result hit the row cap, so what you are reading is not the answer |

The two `routine.*` entries are why a function's ddl tab is the most
promising surface in the product for this: a body is dense with
checkable things, and unlike a table's shape, the text is right there to
annotate.

### Testing

The rules are pure, so the tests are the cheap part and there is no
excuse for thin coverage. Per rule: a fixture that fires, a fixture that
does not, and a fixture that *cannot tell* and must stay silent.

Beyond that, the brand spec's own acceptance checks become assertions
over the catalogue, run once for every rule:

- Every rule has all four attitude strings. A missing `fatal` string
  cannot fall back to `warning`; that is how a level silently stops
  existing.
- No string exceeds 90 characters at `notice` or `warning`.
- No string at **any** level, including `panic`, matches the slur
  denylist. "Swearing at a query is funny; punching downward is not, and
  it is the one thing that would follow the product around."
- `notice` strings contain no profanity.
- Every string names a construct — it interpolates at least one fact.
  This is the automatable half of "be specific"; generic snark is
  filler.
- No two rules share an id.

The half that cannot be automated is whether a gripe is *funny*, and
that is a review gate, not a test.

## Open questions

- **Which rules ship.** The reserved decision. Everything above is
  machinery for a catalogue that does not exist.
- **Is a dismissal personal or team-wide?** Proposed team-wide, on the
  grounds that a schema finding is a team fact. The counter-argument is
  real: one member silencing a blocker for everyone is a way to lose the
  finding that mattered. A middle option is team-wide for `object`
  targets and personal for documents.
- **`EXPLAIN`, and whether it is automatic.** Plan-based rules are the
  ones that would justify the product, and they cost a target-database
  round trip per statement. Automatic on every edit is clearly wrong;
  automatic on every execution is arguable; a button is safe and will be
  under-used. Undecided.
- **Firing volume.** No rule for how many gripes is too many. A panel
  with 200 rows is the annotation rail problem again — it stops being a
  map. Options: cap per document, collapse repeats of one rule into a
  count, or rank and show the top n.
- **Localisation.** From the brand spec's open items: "Profanity does not
  translate at consistent strength. Each locale needs its own
  calibration, not a translated string table." So a locale is a
  re-authoring job per rule, which changes the shape of `messages.ts`
  from a map to a per-locale catalogue. Not designed here.
- **Severity vs the project class.** A `blocker` in a `local` sandbox
  and a `blocker` in `production` are not equally urgent. Whether the
  class modulates severity, or only the wording, or neither, is open.
- **Does a session `set datagripe.attitude` statement really execute?**
  Treating it as a real statement the editor intercepts is a lovely
  touch and a parsing special case. The alternative is a plain control
  in the panel, which already exists.
