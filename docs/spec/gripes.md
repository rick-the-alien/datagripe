# Spec — Gripes engine

**Status:** draft — machinery and the editor/panel surfaces are built
**Phase:** 11 (planned)
**Supersedes:** nothing (implements `docs/brand/brand-system.md` "Voice",
"Attitude levels", "Writing gripes", and the tier-3 mascot rule)

> Built: `packages/gripes` (rule shape, runner, renderer, catalogue and
> its assertions), the wire types in contracts, `scanTokens` in
> sql-tools, eleven rules, a client `SchemaInput`, dismissal at all
> three scopes, and four
> surfaces — editor gutter and squiggle, annotation rail, gripes panel,
> object-view annotations, status-bar count.
>
> Not built: the server-side runner on the execution path, which waits on
> a rule with `execution` inputs.

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
    types.ts          Rule, GripeContext, the five input shapes
    catalogue.ts      the rule registry
    messages.ts       ruleId → { notice, warning, fatal, panic }
    render.ts         Finding + attitude → string, and the footer
    runner.ts         given available inputs, run the applicable rules
    statement.ts      tokenize once per statement, not once per rule
    assertions.ts     the mechanical checks over the catalogue
```

The wire types — severity, attitude, location, finding — live in
`packages/contracts/src/gripes.ts` instead, because a finding crosses
the socket when the server evaluates an execution rule.

Static analysis rests on `scanTokens` in `packages/sql-tools`: a token
walk that shares the statement splitter's awareness of comments, string
literals, quoted identifiers and dollar-quoted bodies. That sharing is
the whole point — a rule scanning raw text with a regex fires on the
word `join` inside a comment, and a wrong gripe destroys trust in every
other gripe. Quoted words keep their case, because `"From"` and `"from"`
are different columns.

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

1. **Editor glyph margin and squiggle.** Built. A parallel decoration
   collection to the one `statementMarkers` already uses for execution
   outcomes, with a severity glyph in the gutter and a wavy underline on
   the range. Underline rather than a filled background: a filled range
   would fight the syntax colours it sits on. The hover carries the
   rendered sentence and the footer.
2. **Gripes panel.** Built. Rows grouped by document, worst first, each
   with its severity glyph and footer. Clicking a row reveals the offset
   in whichever view holds that document and focuses the editor —
   `revealPositionInCenterIfOutsideViewport`, so a finding already on
   screen does not throw away the reader's sense of place. The attitude
   selector drives the wording live.
3. **Object view.** Built. An annotation block above the tab's content,
   in the shape the tree-interactions mock shows. A finding carries the
   tab it belongs to, so an index complaint stays on `indexes` and does
   not follow you to `grants`; a finding with no tab shows on all of
   them. Above the content rather than replacing it — a complaint about
   an index reads best next to the indexes.

   Object rules run in the object view itself, because the describe
   result is their whole input. The findings are published into the
   gripes store so the panel and the status-bar count agree with what
   the tab is showing: a count reading "no gripes" beside two visible
   gripes would undermine every other number the tool prints.
4. **Annotation rail.** Built, on Monaco's overview ruler, which is
   exactly this: marks beside the vertical scrollbar showing where
   findings are in the *whole* document, not just the visible window.
   Capped at forty, because "a rail with two hundred marks is a
   gradient, not a map" — and since findings are sorted worst first, the
   cap drops style notes before blockers.
5. **Status bar.** Built. A count, and magenta when any finding is a
   blocker — so the one that matters is not averaged away by a pile of
   style notes.

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

Stored server-side per workspace (`gripe_dismissals`) so a dismissal
survives a browser and is visible to the team. It is **team-wide**,
because a schema finding is a team fact — still an open question, so
`dismissed_by` is recorded on every row, which is enough to make it
personal later without losing history. A scratchpad's dismissal
references a document id the server does not otherwise know; harmless,
and worth knowing.

**An occurrence dismissal cannot key on a document offset.** Offsets
move the moment anything above them is typed, so the dismissal would
evaporate on the next keystroke. It keys on a hash of the statement's
normalized text instead, which gets the behaviour right in both
directions: editing an unrelated statement — or running the formatter —
keeps the dismissal, and editing *this* statement drops it, because the
finding may no longer hold once the text changed.

Dismissing the same thing twice is a no-op rather than an error, via a
unique index over `(workspace, rule, scope, key)`. `project` scope has
no key and stores `''`, so one index covers all three scopes.

Dismissal is never silent. The panel keeps a count of what is hidden and
a "show all again" beside it, or the feature becomes a way to make the
tool lie quietly. A dismissed finding also leaves the gutter and the
rail — silencing the panel while the squiggle argues with it would be
worse than not dismissing at all. Findings stay in the store either way,
so restoring costs no re-analysis.

The scope labels say what they mean rather than what they are called:
"not here", "not in this file" (or "not on this object"), "never in this
project".

### Rule ids are a public contract

A rule id appears in the gripe footer, in dismissal rows, and in
whatever anyone greps their logs for. Renaming one silently un-dismisses
it for every user. So: ids are stable, and a rule that changes meaning
gets a new id rather than new behaviour under the old one.

Format is `<subject>.<problem>`, lower-kebab: `join.no-condition`,
`index.missing`, `table.no-primary-key`, `select.unqualified-star`,
`routine.volatile-but-readonly`.

### The catalogue

Every rule earns its place by knowing something the query text alone
does not, or by being about damage rather than tidiness. What is
deliberately absent is style filler — a formatter's job, and the fastest
way to get the whole thing switched off.

| Rule | Severity | Inputs | Fires on |
| --- | --- | --- | --- |
| `routine.definer-no-search-path` | blocker | object | `security definer` with no `search_path` pinned |
| `join.no-condition` | blocker | statement | a join with no `on` or `using` |
| `delete.no-where` | blocker | statement | a delete that removes every row |
| `update.no-where` | blocker | statement | an update that rewrites every row |
| `column.nullable-inequality` | warning | statement, schema | `col <> 'x'` where the schema says `col` is nullable |
| `subquery.not-in` | warning | statement | `NOT IN (SELECT ...)`, which returns nothing at all if the subquery yields a null |
| `table.no-primary-key` | warning | object | a base table with no addressable row |
| `view.select-star` | warning | statement | a view whose column list the star froze at creation |
| `index.not-concurrent` | warning | statement | `CREATE INDEX` with no `CONCURRENTLY`, which blocks writes for the build |
| `index.duplicate` | style | object | an index whose keys prefix another's |
| `routine.volatile-but-readonly` | style | object | a read-only `sql` routine left volatile |

Two of these are about something the statement text actively
misrepresents. A star in a view reads as a standing instruction and is
not one: the database expands it once, at creation, and records the
result, so a column added later never appears. And `NOT IN` against a
subquery reads as the negation of `IN` and is not one: a single null in
that subquery makes the whole predicate unknown, so the query answers
zero rows with no error and no clue. The shape is the finding in both
cases — nothing at the call site says whether the subquery's column is
nullable, and it can become nullable later without this query being
touched.

`column.nullable-inequality` is the first rule that needs the schema,
and it is deliberately about the *inequality* and not the equality.
Most columns are nullable, and `col = 'x'` excluding nulls is what
everyone expects, so griping there would fire on half the queries in
the tool and get the whole feature switched off. The negation is where
the reading and the behaviour come apart: "status <> 'void'" reads as
everything that is not void, and nulls are obviously not void, but the
comparison is unknown for those rows so they are dropped in silence.

`routine.definer-no-search-path` is the one that is about a
vulnerability rather than a cost: a definer routine runs with the
owner's privileges but resolves unqualified names using the *caller's*
`search_path`, so anyone who can create a schema can shadow something
the body calls and have it run as the owner.

**Where the correctness discipline actually bit.** Each of these has a
"looks like the finding and is not" fixture class, because that is where
a wrong gripe would come from:

- `delete.no-where` reads the statement's *main verb*, looking through a
  leading `WITH`. Without that, `create trigger t after delete on x`
  reads as an unqualified delete — and it would fire on every trigger in
  the database.
- `index.duplicate` treats a prefix as covered but not an equal column
  list, and never a unique index: a unique index enforces something the
  wider index does not, so dropping it changes behaviour rather than
  saving writes.
- `view.select-star` distinguishes a projection star from
  multiplication by what surrounds it: a star follows `select`, a comma
  or a qualifier's `.`, and precedes a comma or `from`. Depth alone is
  not enough — the `*` in `select qty * price` sits at the same depth as
  a real one, so without this the rule fires on arithmetic.
- `index.not-concurrent` is gated on the *dialect*, not the adapter id.
  `CONCURRENTLY` is not merely unhelpful advice on MySQL and SQLite; it
  is a syntax error, so a gripe suggesting it would be actively wrong.
- `subquery.not-in` stays on the adjacent `NOT IN` form and never fires
  on `NOT EXISTS`, which is the fix, nor on a written-out list, where a
  null is visible to whoever reads it.
- `routine.volatile-but-readonly` reads the routine *body*, not the
  definition. Checking the whole definition finds `CREATE` in every
  routine, so the rule never fires at all — which is how it was first
  written, and what its test caught. It also declines to judge a plpgsql
  body, which can write through dynamic SQL that no amount of reading
  will reveal.

### The client's SchemaInput

Built, backed by the completion catalog, and honest about what that
cache does and does not hold. `isNullable` is real; `rowsFor` and
`indexLeadsWith` always answer `null`, because the catalog carries
neither. They are declared rather than omitted so a rule needing them
compiles and stays quiet, instead of the runner having to know which
parts of the schema each caller can supply.

The catalog fetches a table's columns on demand, so a schema rule's
first look usually knows nothing and correctly says nothing. Asking for
the columns is the side effect; when they arrive the catalog notifies,
the store re-analyses, and the finding appears — a beat late, but never
wrong. That is the whole reason `null` may not be read as `false`: a
rule treating "not fetched" as "NOT NULL" would go silent on a real
problem, and one treating it as "nullable" would invent one.

Two things had to be fixed before a schema or dialect rule could be
trusted at all, and both were silent:

- `scanTokens` dropped any character it did not recognise, and `!` was
  not in its punctuation set. `a != 1` therefore tokenized identically
  to `a = 1`, so a rule about equality would have fired on its exact
  opposite. Multi-character operators are now single tokens.
- `SqlDialect` was `keyof Record<string, ...>`, which is `string`, so
  every caller type-checked and the editor was passing a hardcoded
  `"postgres"` for every connection. A dialect-gated rule would have
  fired on MySQL. The dialect is now a real union, resolved from the
  adapter's `sqlDialect` capability — a capability and not the adapter
  id, since Redis is an adapter with no dialect at all.

### Still on the list

- `index.missing` needs to know a relation's indexes, which the
  completion catalog does not carry. The object describe result does, so
  this waits on either widening the catalog or a server-side runner.
- `execution.truncated` needs the server-side runner.
- `select.unqualified-star` is **not** going to ship as specified. In a
  SQL client, `select * from t limit 100` is the single most common
  legitimate query there is, and griping at it is precisely the style
  filler this catalogue exists to avoid. The freezing case has real
  teeth and shipped as `view.select-star`; the ad-hoc case does not.

### Analysis is debounced, and per document

The client runner re-analyses on document content change, debounced 400ms
per document through the same keyed debouncer the draft checkpoints use —
long enough that typing mid-word does not flicker findings.

Each statement is analysed separately, with its document offset passed
in, so a finding in the third statement still points at where it is in
the whole document rather than at an offset into that statement. That is
the one thing easy to get wrong here and it has a test.

### Testing

The rules are pure, so the tests are the cheap part and there is no
excuse for thin coverage. Per rule: a fixture that fires, a fixture that
does not, and a fixture that *cannot tell* and must stay silent.

Beyond that, the brand spec's own acceptance checks become assertions
over the catalogue (`assertions.ts`), run once for every rule:

- Every rule has all four attitude strings, none blank. A missing
  `fatal` cannot fall back to `warning`; that is how a level silently
  stops existing.
- No string exceeds 90 characters at `notice` or `warning`.
- No string at **any** level, including `panic`, contains a barred term.
  "Swearing at a query is funny; punching downward is not, and it is the
  one thing that would follow the product around."
- `notice` contains no sanctioned profanity.
- Rule ids are `<subject>.<problem>` in lower-kebab, and unique.
- No rule declares zero inputs, and no wording exists for a rule that
  does not.
- Rendering a rule's own fixtures leaves no unresolved `{placeholder}`.

Matching is on word boundaries throughout: a substring check that flags
"hello" for containing "hell" is worse than no check, because it trains
people to work around it.

**Two things are deliberately not asserted.**

*"Every string interpolates a fact"* was in an earlier draft of this
spec and is wrong. The brand spec's own approved calibration example —
"This join has no condition. I'll allow it. I won't forget it." — names
nothing at all. Specificity for a statement rule comes from the
*location*, which points at the construct; a fact is how a rule is
specific when it has a number worth quoting. Asserting the fact would
have failed the brand spec's own copy.

*Whether a gripe is funny.* That is a review gate, not a test.

### The barred-term list, and the disclaimer instead of a gate

`BARRED_TERMS` starts empty and grows alongside the wording: a rule
arrives with four strings, anything those strings prove they need
fencing off is added, and `assertNoBarredTerms` keeps it fenced for
every rule that follows. An enumerate-it-up-front gate was considered
and dropped — this is free software with no public release to gate, and
a list nobody has a rule to test against is guesswork wearing a
checklist.

What actually holds the line is the brand spec's rule, which is a review
standard rather than a string match: "nothing touching race, gender,
sexuality, disability or religion at any level", and "it criticises the
query, never the person who wrote it". A string match cannot enforce
either; it can only catch a regression in something already decided,
which is what it is for.

The reader gets told as much. `DISCLAIMER`, shown beside the attitude
control in the panel:

> Gripes criticise the query, never the person who wrote it. fatal and
> panic swear; choose notice if that is unwelcome.

It sits next to the attitude control because that is where someone picks
the register, and it is written in the plain product voice, not the
gripe voice — "if the whole interface is sarcastic then nothing is".

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
