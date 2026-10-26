# Backlog

One markdown file per item: `BL-NNNN-short-slug.md`. One file per item (instead of one big
board) means parallel sessions rarely conflict. Copy [`_template.md`](_template.md) to add one.

The board is derived, not maintained: run `/status` to have the scrum master summarise
items by status, what is blocked, and what can start next.

## Frontmatter fields

| Field | Values | Notes |
|---|---|---|
| `id` | `BL-NNNN` | Next free number |
| `title` | text | Short, user-facing |
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
