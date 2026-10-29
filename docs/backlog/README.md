# Backlog

One markdown file per item: `BL-NNNN-KIND-short-slug.md`, e.g. `BL-0007-ARCH-auth-strategy.md`.
An item split from a parent carries the parent's ID right after its own:
`BL-NNNN-BL-PPPP-KIND-short-slug.md`, e.g. `BL-0018-BL-0017-CODE-services-manage-services.md`
is item 18, a child of `BL-0017`. The parent ID must match the `parent` field. Top-level items
have no parent segment.
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
- The `id` never changes. If the kind or parent has to change, rename the file (`git mv`)
  and update `kind`/`parent`; references use `BL-NNNN` so they stay valid.
- Only direct children carry their parent's ID (one level, not the whole ancestry).
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
| `qa` | `skip` \| `light` \| `full` | QA tier, see below. Missing or unclear means `full` |
| `spec` | path or empty | e.g. `docs/specs/booking.md` |
| `pr` | URL or empty | Set by the developer |

## QA tier

QA is the most expensive step, so how much of it an item gets is decided per item. The architect
proposes the tier in the `qa` field, the product owner confirms it at `/deliver` pre-flight, and
the reviewer may raise it (never lower it).

| Tier | Use when | What happens in the `in-qa` step |
|---|---|---|
| `skip` | Docs, ADR, backlog or tooling changes; config tweaks; a change with no behaviour change | No QA. Reviewer approval plus a green build and tests closes the item. |
| `light` | Small code change where every acceptance criterion is already covered by a named automated test | The orchestrator maps each criterion to its test and the reviewer's test run. No QA subagent. |
| `full` | New endpoint or page, DB schema or migration, auth, public API shape, kit/booking boundary, or any criterion with no automated test | The `qa` agent, as before. |

Rules:
- When in doubt, `full`. A missing `qa` field is `full`.
- `light` must be escalated to `full` if any criterion has no automated test, or a test it relies on
  was changed in the PR without the reviewer noting why.
- `BUG` items found by QA, and items touching auth, tenancy or money, are never below `light`.
- Whoever closes a `skip` or `light` item logs the tier and the evidence per criterion in the *Log*.

## Sections

- **Goal**: why, from the user's point of view.
- **Acceptance criteria**: numbered, testable. QA verifies each one.
- **Design**: filled by the architect: approach, contracts, files likely touched.
- **Open questions**: for the product owner. Unanswered questions block the item.
- **Log**: append-only, one line per hand-off: `YYYY-MM-DD HH:MM role: what happened`.
  Time is 24-hour local time of the machine; read it from the system (`date '+%Y-%m-%d %H:%M'`)
  rather than guessing, and never edit or reorder earlier lines.
