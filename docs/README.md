# DataGripe documentation

Living documentation for DataGripe. `docs/initial_idea.md` is the original
engineering handoff; everything in `adr/`, `spec/`, and `rfc/` reflects
decisions made after it and takes precedence where they conflict.

## Conventions

| Folder | Contents | Lifecycle |
| --- | --- | --- |
| `adr/` | Architecture Decision Records — one significant decision per file | Immutable once accepted; supersede, never rewrite |
| `spec/` | Feature and subsystem specifications — current intended behavior | Updated in the same change as the implementation |
| `rfc/` | Proposals under discussion | Promoted to `spec/` (plus an ADR if a decision was made) or dropped |

### ADR format

Files are numbered `NNNN-kebab-title.md` and contain: Status
(`proposed` / `accepted` / `superseded by NNNN`), Date, Context, Decision,
Consequences.

### Spec format

Files are `kebab-title.md` and contain: Status (`draft` / `current` /
`deprecated`), Goal, Non-goals, Design, and Open questions. A spec marked
`current` MUST match the code; if the code changes, the spec changes in the
same commit.

### RFC format

Same shape as a spec, plus Alternatives considered. RFCs are discussion
documents; nothing in `rfc/` is a commitment.

## Rules

- Documentation is updated in the same change as the behavior it describes.
- The [roadmap](../roadmap.md) is the single source of truth for what is
  planned, in progress, and shipped.
