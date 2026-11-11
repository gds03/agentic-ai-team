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
- Every `EPIC` has a **How the epic gets delivered** section in its *Design*, written by the
  architect when it splits the epic and checked by the scrum master (see below).

## How the epic gets delivered

The product owner asks "in what order does this epic get built?" for every epic, and the answer is
otherwise scattered over the children's `depends_on`. An epic's *Design* therefore carries a section
named **How the epic gets delivered**, derived from the children's `depends_on`:

- **Stages**: the children grouped in the order they can start, with what each stage delivers in
  one line. Name items outside the epic that gate it (for example kernel or database items) and say
  they are outside.
- **Parallel and sequential**: which children run together and which wait, each with the reason
  (a dependency, or the same files).
- **Diagram**: a small text diagram of `depends_on`.
- **Critical path**: the longest chain, and which stage has slack, so the owner can start gating
  work early.
- **Needs the product owner**: pre-flight confirmations, decisions and merges the stages wait for.

Keep it to children and gating items; do not repeat their criteria. The architect writes it when it
splits the epic. The scrum master checks it matches `depends_on` whenever it adds, splits, reorders
or finishes a child, fixes it or sends it back to the architect if it has drifted, and reports a
mismatch in `/status`.

The board is derived, not maintained: run `/status` to have the scrum master summarise
items by status, what is blocked, and what can start next.

## Worktrees on the board

Agents work in parallel git worktrees, so their item files differ from `main`. `node tools/board.mjs`
reads `git worktree list` (no frontmatter field needed) and loads this folder from every worktree. The
first worktree is the base; for every other worktree the item files its branch changed (committed or
not) override the base copy, and items that exist only there are added. Cards show the branch, an
"uncommitted" marker and a flag when the branch status differs from `main` (for example done on the
branch, designed on main until the PR merges). The "In flight by worktree" panel lists each worktree.
So agents must keep an item's `status` and *Log* current in their own worktree. `--dir` reads one
folder only.

The docs viewer (`node tools/docs.mjs`) does the same for every document it lists, not only items:
the backlog, specs, ADRs, research notes and other `.md` files that a worktree's branch added or
changed replace the base copy (or are added), with the branch badge, the "uncommitted" marker, the
status drift flag and an "also in <branch>" flag when two worktrees change the same file. Its
"Only in other worktrees" toggle shows just that work in flight.

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
| `qa_scope` | `slice` \| `area` \| `full` | Which tests run locally, see *Test scope* below. Missing means `slice` |
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

## Test scope

The `qa` tier says *how much QA effort* an item gets; `qa_scope` says *which tests run locally* while
doing it. The full suite (including Testcontainers integration tests) is slow, and it already runs in CI
on every pull request, so agents run only what the item touched. The architect proposes `qa_scope`, the
product owner confirms it at pre-flight, and the reviewer may raise it (never lower it).

| Scope | Use when | Developer and QA run locally |
|---|---|---|
| `slice` (default) | The change stays inside one slice's folder and its mirrored tests | Build, plus the tests of that slice (e.g. `--filter-namespace "*Features.Services.ManageServices*"`) |
| `area` | Touches an area's `Shared` folder or several slices of one area | Build, plus the tests of that area |
| `full` | Touches the kernel, the shared `DbContext`, migrations, DI registration, infrastructure or `ShopKit.Base` | Build, plus the full suite |

Rules:
- Slices never use each other's types, so a change confined to one slice cannot break another; that is why `slice` is safe as the default.
- CI runs the full suite on every PR, and it must be green before the product owner merges. Nobody else repeats it.
- Whoever runs a reduced scope logs the filter they used in the *Log*.
- A `qa_scope` below what the diff touches is a reviewer finding.

## Sections

- **Goal**: why, from the user's point of view, followed by a **goal diagram**: a short text diagram in a
  code block (about 12 lines at most, 80 columns, product words, no class names) in three named steps
  that read top to bottom: `TODAY` (the problem), `THIS ITEM` (the work), `AFTER` (what is true once it
  is done). Arrows only show order; details go inside the steps. It illustrates the Goal text, it does
  not replace it. For an `EPIC`: the problem, the children, the outcome they add up to; for a `BUG`: the
  failing path, then the expected one; for `RESEARCH` / `ARCH`: the question, the decision, what it
  unblocks. Example in `CLAUDE.md` (*Goal diagram*).
- **Acceptance criteria**: numbered, testable. QA verifies each one.
- **Design**: filled by the architect: approach, contracts, files likely touched.
- **Manual test script**: optional, written by `/try` after *Design* and before *Open questions*, so
  the click-by-click steps stay with the item. It is a collapsed `<details>` block
  (`<summary>Manual test script (from /try)</summary>`, no `open` attribute), so it renders closed on
  GitHub and in `tools/docs.mjs`. `/try` replaces the block on each run (it is regenerated from the
  criteria and Log, not append-only) and records that in the *Log*.
- **Open questions**: for the product owner. Unanswered questions block the item. Every question has
  **examples**, so the owner sees the real problem and decides without reading the spec:
  - One line says what the owner would notice (screen, customer message, money, time), in product words. No
    class, table or ADR names; a spec section is a pointer only (`spec 17`), never the explanation.
  - Then the **proposed answer** and the **alternatives**, each in one line.
  - Then an **Example** with invented, realistic people, times and prices, played through under the proposal
    and under each alternative, so the difference is visible. Use two examples when one cannot show both
    sides (the usual case and the awkward case). Keep it to a few lines; a small table is fine when the
    answers differ by number.
  - An answered question is rewritten as `answered by the product owner YYYY-MM-DD: <answer>`; the example
    may then be dropped.

  ```
  1. **Q1. Block a time that already has a booking?** Marta blocks 13:00-15:00 for a dentist visit; Joana
     is booked at 14:00 that day.
     Proposed: allowed; Joana's booking is listed as "needs a decision" and Marta moves or cancels it.
     Alternative: refused until Marta has moved Joana first.
     *Example.* Proposed: Marta saves the block at 09:00, sees "1 booking affected: Joana, 14:00", and
     messages Joana from there. Alternative: Marta gets "Move Joana's 14:00 booking first", opens the
     day page, moves Joana, comes back and blocks again, but cannot block in a hurry at 13:30.
  ```

  A question with no example is not ready to ask: the architect adds it before setting `blocked: true`.
- **Log**: append-only, one line per hand-off: `YYYY-MM-DD HH:MM role: what happened`.
  Time is 24-hour local time of the machine; read it from the system (`date '+%Y-%m-%d %H:%M'`)
  rather than guessing, and never edit or reorder earlier lines.
