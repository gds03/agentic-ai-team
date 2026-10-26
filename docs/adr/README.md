# Architecture decision records

One file per decision, written by the architect, named after the backlog item it belongs to:
`BL-NNNN-ADRNNNN-subject.md`, e.g. `BL-0001-ADR0001-tech-stack.md`. The file then sorts next
to its backlog item and shows at a glance which story card it came from. Inside the file the
decision is still called `ADR-NNNN` (heading, references, `superseded by ADR-NNNN`), so
references stay valid even if a file is renamed.

- The `BL-NNNN` is the item that raised the decision (normally an `ARCH` item, see
  `docs/backlog/README.md`), and it must match the `Backlog:` line in the file.
- ADR numbers are global and sequential (next free `ADRNNNN`); one backlog item can have
  several ADRs (`BL-0001-ADR0001-...`, `BL-0001-ADR0002-...`).
- Link the ADR from the item's *Design* section, and mention the ADR ID in the item's *Log*.

Status is `proposed` until the product owner accepts it, then `accepted`; a later ADR can
mark an earlier one `superseded by ADR-NNNN`.

```markdown
# ADR-NNNN: <decision>

- Status: proposed
- Date: YYYY-MM-DD
- Backlog: BL-NNNN

## Context
What forces the decision. Link research notes.

## Options
1. Option A: pros / cons
2. Option B: pros / cons

## Decision
What we do and why.

## Consequences
What becomes easier, harder, or must happen next.
```
