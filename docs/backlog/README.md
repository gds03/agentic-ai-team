# Backlog

One markdown file per item: `BL-NNNN-KIND-short-slug.md`, e.g. `BL-0007-ARCH-auth-strategy.md`.
One file per item (instead of one big board) means parallel sessions rarely conflict. Copy
[`_template.md`](_template.md) to add one.

## Kind (filename tag)

The `KIND` tag tells you at a glance what kind of work the item is. It is also stored in the
`kind` frontmatter field and must match.

| KIND | Work | Typical owner | Output |
|---|---|---|---|
| `EPIC` | Large outcome, split into child items via `parent` | architect / scrum-master | child items |
| `ARCH` | Architecture: spec, ADR, contract, splitting work | architect | `docs/specs/`, `docs/adr/` |
| `CODE` | Implementing a slice (feature or task) | developer | code + unit tests + PR |
| `RESEARCH` | Spike answering an open question | researcher | note in `docs/research/` |
| `QA` | Integration/e2e tests, regression passes | qa | tests, QA report |
| `BUG` | A defect to fix | developer (found by qa) | fix + regression test |
| `DOCS` | Documentation only | any | docs |

Rules:
- Pick the kind by the item's **main deliverable**, not by the stage it is in. A `CODE`
  item still goes through design, review and QA; it does not turn into `ARCH` or `QA`.
- The `id` never changes. If the kind has to change, rename the file (`git mv`) and update
  `kind`; references use `BL-NNNN` so they stay valid.
- Split items follow the same rule: an `EPIC` is split into `ARCH`, `CODE`, `QA`... children.

The board is derived, not maintained: run `/status` to have the scrum master summarise
items by status, what is blocked, and what can start next.

## Frontmatter fields

| Field | Values | Notes |
|---|---|---|
| `id` | `BL-NNNN` | Next free number |
| `title` | text | Short, user-facing |
| `kind` | `EPIC` \| `ARCH` \| `CODE` \| `RESEARCH` \| `QA` \| `BUG` \| `DOCS` | Same as the filename tag, see above |
| `type` | `feature` \| `task` \| `bug` \| `spike` | `spike` = research only, output is a note in `docs/research/` |
| `status` | `idea` \| `designed` \| `ready` \| `in-progress` \| `in-review` \| `in-qa` \| `done` | See the workflow in `CLAUDE.md` |
| `priority` | `P0` \| `P1` \| `P2` \| `P3` | P0 = blocks everything |
| `depends_on` | list of IDs | Must all be `done` before this is `ready` |
| `parent` | ID or empty | For items split from a larger one |
| `owner` | role currently holding it | e.g. `developer` |
| `blocked` | `true` \| `false` | `true` when waiting on the product owner |
| `spec` | path or empty | e.g. `docs/specs/booking.md` |
| `pr` | URL or empty | Set by the developer |

## Sections

- **Goal**: why, from the user's point of view.
- **Acceptance criteria**: numbered, testable. QA verifies each one.
- **Design**: filled by the architect: approach, contracts, files likely touched.
- **Open questions**: for the product owner. Unanswered questions block the item.
- **Log**: append-only, one line per hand-off: `YYYY-MM-DD role: what happened`.
