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
- **in-qa → done**: depends on the item's `qa` tier (`skip` | `light` | `full`, set by the
  architect, confirmed by the product owner at pre-flight, raisable but never lowerable by the
  reviewer; rules in [`docs/backlog/README.md`](docs/backlog/README.md)). For `full`, QA
  verifies every acceptance criterion, adds integration tests where useful, and marks it done.
  For `light` the orchestrator checks each criterion against a named passing automated test;
  for `skip` reviewer approval plus green build and tests is enough. Both log their evidence. A failure goes back to `in-progress` with a reproduction;
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

`/deliver BL-NNNN` first stops for a **pre-flight confirmation**: it summarises the item
(goal, criteria, dependencies, open questions, what will be touched, red flags) and asks the
product owner to confirm, adjust, or review the overall direction. Nothing is delegated
until they say yes, every time. Then it runs the whole chain for one item inside a single
session: architect (if not designed) → developer → reviewer → developer fixes (max 2 rounds) →
qa → PR. The orchestrating session acts as scrum master: it hands each agent the item
file path and the outputs of the previous step, and records each hand-off in the item's
*Log*. Once the PR is open, `/try BL-NNNN` (a helper, not an agent) launches the branch locally
and gives the product owner a click-by-click test script. Other commands: `/groom`, `/design`,
`/implement`, `/review`, `/qa`, `/research`,
`/status` (see `.claude/commands/`).

Several sessions can run in parallel (e.g. one per item, plus research sessions). To avoid
conflicts, **one session owns one item at a time** and only edits that item's file and
the code the item covers.

**Parallel delivery.** When asked to deliver several items at once (e.g. "deliver A and B in
parallel"), check first that none depends on another, run each pre-flight and wait for the product
owner's yes on each, then give every item its own git worktree (`isolation: "worktree"` on the
Agent call) and its own branch created from `origin/main` (`git fetch && git checkout -b
bl-NNNN-slug origin/main`), never from the branch that happens to be checked out. The developer,
reviewer and QA of one item all work on that item's branch; nothing is shared between items except
`origin`. The second PR to merge may need a rebase, which its developer does.

**Cleanup after merge.** A merged PR leaves its worktree and local branch behind. The next time the
product owner says an item is merged, or starts a new item, the orchestrator removes the finished
ones: check that `git status` in the worktree is clean and that the branch is merged into
`origin/main` (`git branch --merged origin/main`), then run `git worktree remove <path>` and
`git branch -d <branch>`. Never remove a worktree with uncommitted changes or unpushed commits;
report it instead. `git worktree prune` clears entries whose folder is gone. Remote branches are
left to the product owner.

## Conventions

- **IDs**: backlog items `BL-NNNN`, ADRs `ADR-NNNN`. Take the next free number.
- **Backlog filenames** carry the kind of work: `BL-NNNN-KIND-short-slug.md`, with KIND one
  of `EPIC`, `ARCH`, `CODE`, `RESEARCH`, `QA`, `BUG`, `DOCS` (e.g. `BL-0007-ARCH-auth-strategy.md`),
  mirrored in the item's `kind` field. An item split from a parent adds the parent's ID after
  its own: `BL-0018-BL-0017-CODE-services-manage-services.md` (matches `parent: BL-0017`). Rules in [`docs/backlog/README.md`](docs/backlog/README.md).
  Always refer to items by ID (`BL-0007`) in commits, PRs and `depends_on`.
- **ADR filenames** name the backlog item they belong to: `BL-NNNN-ADRNNNN-subject.md`
  (e.g. `BL-0001-ADR0001-tech-stack.md`). Inside, the decision is still `ADR-NNNN`. Rules in
  [`docs/adr/README.md`](docs/adr/README.md).
- **Item logs** are append-only, one line per event, stamped with date and time:
  `YYYY-MM-DD HH:MM role: what happened` (local time, taken from the system clock via
  `date '+%Y-%m-%d %H:%M'`, not guessed).
- **Branches**: `bl-NNNN-short-slug` when you choose the name; if the environment assigns
  a branch, use it and put the item ID in the PR title.
- **Commits**: imperative mood, prefix with the item ID, e.g. `BL-0007: add booking slot validation`.
- **One item per PR.** The PR body links the item file and lists how each acceptance
  criterion is covered.
- **Definition of done**: code builds, all tests pass, reviewer approved, every
  acceptance criterion verified at the item's QA tier, docs/specs updated if behaviour changed, item status `done`.
- **Tests**: developers write unit tests with the code; QA owns acceptance, integration and
  end-to-end tests. Never skip, disable or delete a failing test to get green.
- **Class design** (concrete rules; "SOLID" is the reason, these are the checks):
  1. *One reason to change.* If a class's job cannot be said without "and", split it.
  2. *Behaviour lives in instances, not static classes.* Handlers, validators, rules,
     services and endpoints' logic are ordinary classes that receive their dependencies by
     constructor injection. `static` is for pure functions (the result depends only on the
     arguments: no I/O, clock, randomness, configuration or state) and for registration and
     extension methods; never for code that reads or writes anything or holds state.
  3. *Depend on abstractions at real seams.* Use a small interface where behaviour varies or
     is replaced in tests (clock, a boundary another area uses, an external store or service,
     a family of rules). Wrapping the project's own `DbContext` is not a seam when an ADR says
     handlers use it directly. Do not add an interface for a class with one implementation
     and no seam.
  4. *Extend by adding.* A new rule or handler is a new class registered in DI, not another
     branch in an existing one.
  5. *Small interfaces.* A consumer depends only on the members it uses.
  6. *Never create a collaborator inside a class* with `new` (except plain values); receive it.
  The architect names each class's single responsibility in the spec; the reviewer checks
  these rules. Apply them to new code and to code you touch anyway.
- **Dependency diagram** (so a reader sees the shape of a mechanism without opening every file):
  when a mechanism or feature needs three or more classes (a kernel mechanism such as the
  schedule lock, or a slice with several collaborators), its spec or the item's *Design* holds a
  class dependency diagram: an arrow means "uses", each class carries its kind in brackets
  (scoped service, record, interceptor, ...), and a table beside it lists what each class depends
  on and who creates it. Draw it as plain text in a code block (it renders everywhere, including
  `tools/docs.mjs`). The architect draws it, the developer updates it in the same PR when the
  classes change, and the reviewer checks it against the code and the *Class design* rules (an
  arrow into a static class, or a class that creates its own collaborator, shows up there).
  Apply it to new work; do not backfill mechanisms nobody touches. `BL-0099`'s *Class
  dependencies* section is the reference example.
- **Folder and file layout as a tree** (so a reader sees where things live without joining paths
  in their head): whenever a spec, ADR, backlog item, research note or report says where code,
  tests or docs live and names two or more paths, it shows them as a text tree in a code block
  (`├─`, `└─`, `│`, one entry per line, a short note after the entry where it helps, and the owning
  item ID where several items own parts). A table of paths alone is not enough; it may stay beside
  the tree for the columns a tree cannot carry (owner, reason). A single path in a sentence is fine
  as inline code. Apply it to new work and to sections you touch anyway; do not backfill untouched
  files.
- **Architecture**: the application is built as **vertical slices**. Each use case
  (e.g. book an appointment, send a reminder, create a tenant) is one slice in
  `Features/<Area>/<UseCase>/` that owns its endpoint or page, request/response types,
  validation, handling logic, data access and tests (mirrored under `tests/`). Do not
  organise code by technical layer (no project-wide Controllers/Services/Repositories
  folders). A slice never uses another slice's types; slices share only a small kernel
  (contracts, DbContext, infrastructure) and their area's `Shared` folder. Backlog items are
  written and split **per slice**, so one item is normally one slice, and the kit/booking
  boundary below still applies. Record the exact folder rules in an ADR.
- **Data carriers versus logic** (so a reader can see at once which classes own logic): types
  that only carry data (request and response records, DTOs, view models, event payloads,
  options) are not given a file each. A slice keeps them together as nested types of one
  holder class named `<UseCase>Data`, in `<UseCase>Data.cs` (for example `ResetPasswordData`
  containing the records `ResetPasswordRequest` and `ResetPasswordResult`). A type that
  owns behaviour (handler, validator, rule, service, endpoint, a record with decisions in its
  methods) gets its own file named after the type, and does not live inside a data holder.
  If a data type grows logic, it moves out to its own file. A file whose name ends in `Data`
  therefore never holds logic, not even display formatting (labels and date formats belong to
  the page); any other file may. Public kernel contracts and kernel options keep their own
  files, because nesting them would rename public API. Apply it to new code and to code you
  touch anyway; do not refactor untouched files for it.
- **Goal diagram** (so the product owner sees the problem at a glance): the *Goal* section of every
  backlog item ends with a short text diagram in a code block that illustrates what we are trying to
  solve: who or what is involved, what goes wrong or is missing today, and what is true after the item
  (`Today` / `Problem` / `After`, or a before-and-after flow). At most about 10 lines of 80 characters,
  plain text so it renders everywhere including `tools/docs.mjs`, in the product's words rather than class
  names. The text of the Goal stays; the diagram illustrates it and does not replace it. The scrum master
  or architect writes it when the item is created, the architect updates it if the design changes what
  is being solved, and the reviewer flags a missing or misleading one. Example:

  ```
  Today:  Customer A --book 10:00--> [check free] -----> [save]  both succeed
          Customer B --book 10:00--> [check free] -----> [save]  = double booking
  After:  Customer A --book 10:00--> [take lock] [check] [save] [release]
          Customer B --book 10:00--> [wait for lock ....] [check: taken] -> no
  ```

  Format in [`docs/backlog/README.md`](docs/backlog/README.md).
- **Key decisions diagram**: an epic, or an item whose *Design* lists four or more key decisions, adds a
  short text diagram after that list showing how the decisions fit together (layers, flow, or what each
  one protects against). Same format limits as the goal diagram (about 12 lines, 80 columns, plain text).
  It is optional below four decisions: do not draw one that only restates a sentence. The architect
  writes and updates it; the reviewer checks it against the decisions and the code.
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
tools/board.mjs         backlog board + weekly report: `node tools/board.mjs --open` (team tooling, no deps)
tools/docs.mjs          live markdown viewer for backlog/specs/ADRs/research: `node tools/docs.mjs --open` (no deps)
docs/PLAN.md            the product plan (source of truth for scope)
docs/backlog/           one markdown file per backlog item
docs/specs/             feature/technical specs written by the architect
docs/adr/               architecture decision records
docs/research/          research notes and option comparisons
docs/TEAM.md            how the product owner drives the team day to day
```
