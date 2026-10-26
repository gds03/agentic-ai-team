# CLAUDE.md

This repository is built by a **virtual software team of Claude agents**. A human
(the product owner) matures ideas and makes decisions; specialised agents design,
implement, review and test. Every Claude session working here must follow this file.

The product plan lives in [`docs/PLAN.md`](docs/PLAN.md). It is the source of truth
for *what* we build. This file defines *how* we build it.

## The team

| Role | Agent | Owns | Never does |
|---|---|---|---|
| Product owner | the human | Vision, priorities, accepting work, answering open questions | — |
| Scrum master | `scrum-master` | Backlog, dependencies, picking the next item, status | Writes product code |
| Architect | `architect` | Specs, ADRs, splitting work into items, interfaces/contracts | Implements features |
| Developer | `developer` | Code + unit tests for one item, opening the PR | Approves own work |
| Reviewer | `reviewer` | Code review against spec, ADRs and conventions | Rewrites the feature |
| QA | `qa` | Acceptance testing against the item's criteria, integration/e2e tests, bug items | Fixes product code |
| Researcher | `researcher` | Answering open questions, comparing options, writing research notes | Changes code |

Agent definitions live in [`.claude/agents/`](.claude/agents). Delegate to them with the
Agent tool (subagent) using the agent name. **Using these subagents is expected and
authorised in this repo** — that is the whole point of the setup.

## Workflow

Every piece of work is a **backlog item** in [`docs/backlog/`](docs/backlog) (see its README).
An item moves through these states, and each transition belongs to one role:

```
idea ──architect──▶ designed ──scrum-master──▶ ready ──developer──▶ in-progress
     ──developer──▶ in-review ──reviewer──▶ in-qa ──qa──▶ done
                         ▲          │ changes requested      │ failed
                         └──────────┴────────────────────────┘
```

- **idea → designed**: the architect writes/updates the spec in `docs/specs/`, any ADR in
  `docs/adr/`, and fills in the item's *Design* and *Acceptance criteria*. Large items are
  split into child items with `depends_on`.
- **designed → ready**: the scrum master checks that every `depends_on` item is `done`
  and that there are no unanswered *Open questions*.
- **ready → in-progress → in-review**: the developer implements on a branch, adds unit
  tests, runs the build and tests, and opens a PR titled `[BL-NNNN] <title>`.
- **in-review → in-qa**: the reviewer approves, or sends it back to `in-progress` with
  concrete findings recorded in the item's *Log*.
- **in-qa → done**: QA verifies every acceptance criterion, adds integration tests where
  useful, and marks it done. A failure goes back to `in-progress` with a reproduction;
  a bug outside the item's scope becomes a new item with `type: bug`.
- **Merging** to `main` is the product owner's call unless they have said otherwise.

### Dependencies and waiting

- Nobody starts an item whose `depends_on` items are not `done`. The scrum master
  reports what is blocked and on what.
- If a role needs a decision from the product owner, it adds the question to the item's
  *Open questions*, sets `blocked: true`, and moves on to other work. It does not guess
  on anything that changes product behaviour.
- Contracts first: when two items touch the same boundary (API, DB schema, message
  format), the architect defines the contract in the spec before either is ready, so
  both can be built in parallel.

### Running the pipeline in one session

`/deliver BL-NNNN` runs the whole chain for one item inside a single session:
architect (if not designed) → developer → reviewer → developer fixes (max 2 rounds) →
qa → PR. The orchestrating session acts as scrum master: it hands each agent the item
file path and the outputs of the previous step, and records each hand-off in the item's
*Log*. Other commands: `/groom`, `/design`, `/implement`, `/review`, `/qa`, `/research`,
`/status` (see `.claude/commands/`).

Several sessions can run in parallel (e.g. one per item, plus research sessions). To avoid
conflicts, **one session owns one item at a time** and only edits that item's file and
the code the item covers.

## Conventions

- **IDs**: backlog items `BL-NNNN`, ADRs `ADR-NNNN`. Take the next free number.
- **Branches**: `bl-NNNN-short-slug` when you choose the name; if the environment assigns
  a branch, use it and put the item ID in the PR title.
- **Commits**: imperative mood, prefix with the item ID, e.g. `BL-0007: add booking slot validation`.
- **One item per PR.** The PR body links the item file and lists how each acceptance
  criterion is covered.
- **Definition of done**: code builds, all tests pass, reviewer approved, QA verified every
  acceptance criterion, docs/specs updated if behaviour changed, item status `done`.
- **Tests**: developers write unit tests with the code; QA owns acceptance, integration and
  end-to-end tests. Never skip, disable or delete a failing test to get green.
- **Architecture**: the application is built as **vertical slices**. Each use case
  (e.g. book an appointment, send a reminder, create a tenant) is one slice in
  `Features/<Area>/<UseCase>/` that owns its endpoint or page, request/response types,
  validation, handling logic, data access and tests (mirrored under `tests/`). Do not
  organise code by technical layer (no project-wide Controllers/Services/Repositories
  folders). A slice never uses another slice's types; slices share only a small kernel
  (contracts, DbContext, infrastructure) and their area's `Shared` folder. Backlog items are
  written and split **per slice**, so one item is normally one slice, and the kit/booking
  boundary below still applies. Record the exact folder rules in an ADR.
- **Decisions**: anything hard to reverse (framework, database, auth, public API shape)
  gets an ADR, status `proposed` until the product owner accepts it.

## Tech stack

_To be filled from `docs/PLAN.md`._ Until then, agents must not pick a stack on their own;
the architect proposes one in an ADR for the product owner to accept.

Build and test commands (keep this up to date once the stack exists):

```bash
# build:  TBD
# test:   TBD
# run:    TBD
```

## Repository layout

```
CLAUDE.md               this file: team workflow and conventions
.claude/agents/         role definitions (architect, developer, reviewer, qa, scrum-master, researcher)
.claude/commands/       slash commands that drive the workflow
docs/PLAN.md            the product plan (source of truth for scope)
docs/backlog/           one markdown file per backlog item
docs/specs/             feature/technical specs written by the architect
docs/adr/               architecture decision records
docs/research/          research notes and option comparisons
docs/TEAM.md            how the product owner drives the team day to day
```
