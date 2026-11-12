---
description: Run the full team pipeline for one backlog item (design → implement → review → QA → PR)
argument-hint: BL-NNNN
---

Deliver backlog item **$ARGUMENTS** end to end. You are the orchestrator (acting as scrum
master). Do not do the specialists' work yourself; delegate each step to the named
subagent with the Agent tool, passing the item file path and the previous step's summary.

0. **Confirm before starting.** Do not delegate to any agent yet. Read the item, its spec
   and `docs/PLAN.md`, then show the product owner a short pre-flight summary: the item
   (ID, kind, title), its goal and acceptance criteria, dependency status, open questions
   (each shown **with its example**; if one has none, have the architect add it first and never
   show a bare question), what the pipeline will do and which files or areas it will touch, and anything that
   looks off (empty plan, vague criteria, conflicting items, unaccepted ADRs). Then ask
   whether to proceed, adjust the item first, or review the overall direction instead.
   Include the item's **QA tier** (`qa:` field, see `docs/backlog/README.md`) with a one-line
   reason, and let the product owner change it. If the field is empty, propose one. Do the same
   for the **test scope** (`qa_scope:` `slice` | `area` | `full`): show it with a one-line reason
   (which folders the item touches), default `slice`. Start
   step 1 only after an explicit yes. Approval covers this item only; ask again next time.
1. Find the item file in `docs/backlog/` for $ARGUMENTS (match on the ID prefix, `docs/backlog/BL-NNNN-*.md`, since filenames carry a
   KIND tag). Check its `depends_on` items are
   `done`. If not, stop and report what it is waiting on.
2. If `status` is `idea`: run the **architect** agent. If it leaves open questions
   (`blocked: true`), stop and report the questions, each with its example. A question the
   architect left without an example goes back to the architect before you report it.
3. Run the **developer** agent to implement and open the PR. As soon as the PR is open, tell
   the product owner they can test it by hand now with `/try BL-NNNN` (it launches the branch; the
   click-by-click script is already written into the item before QA) while review and QA continue. Do not launch it yourself
   unless they ask, and do not wait for them.
4. Run the **reviewer** agent. If changes are requested, send the findings to the
   **developer**, then review again. Stop after 2 rounds and report if still not approved.
   **Manual test script, before QA.** Once the reviewer approves (and any fixes are done), and before
   step 5 starts, write the item's *Manual test script* block yourself, with no agent and without
   launching the app: follow `/try` steps 5 to 7 (`.claude/commands/try.md`) from the acceptance
   criteria, the *Log* and the spec, and save it into the item file after *Design*. Items with no UI or
   runtime behaviour get the short "what to read" checklist instead. Append the *Log* line
   `orchestrator: wrote the manual test script (before QA)`, then commit it on the item's branch
   (`BL-NNNN: manual test script`) and push, so the worktree stays clean for QA. `/try BL-NNNN` later
   launches the app and regenerates the block against the real build if anything differs.
5. Close the item according to its `qa` tier (the reviewer may have raised it; read the
   field again after the review):
   - `full`: run the **qa** agent. If anything fails, send the report to the **developer**,
     then back through **reviewer** and **qa** (again max 2 rounds).
   - `light`: do not spawn an agent. For each acceptance criterion, name the automated test
     that covers it and confirm it passed in the reviewer's run. If any criterion has no
     such test, set `qa: full`, log why, and run the **qa** agent.
   - `skip`: do not spawn an agent. Confirm the reviewer approved and build and tests are green.
   For `light` and `skip`, set `status: done`, append a *Log* line `scrum-master: QA <tier>,
   <evidence per criterion>`, and say in the report that no QA agent ran.
   Developer and QA run only the tests for the item's `qa_scope`; CI runs the full suite on the PR,
   and the report says whether CI is green.
   After the item is set to `done` (or when it first starts), check its parent epic against the *Epic status*
   rule in `docs/backlog/README.md`: set the epic to `in-progress` when this is its first child to start, and
   when every sibling is `done` say in the report "BL-NNNN (epic) is ready to close" for the product owner
   to accept. Never close an epic without that yes.
6. Report: final status, PR link, the QA result per acceptance criterion (and the QA tier
   and test scope used), any new items or open questions created, and any deviation from the criteria that
   the product owner has not accepted yet. Add a **Cost** line: for every agent run of this
   pipeline (resumed and failed runs included) its tokens and duration from its completion
   notification (`subagent_tokens`, `duration_ms`), then the item total and the wall-clock time from
   the first delegation to the report. State plainly that tokens are not the unit of the plan's
   usage limit (which also depends on model and caching), that your own orchestration tokens are
   not counted, and that a run cut short by a usage limit is undercounted, so the product owner
   can compare the totals with their plan's usage screen. End with: "Test it by hand: `/try BL-NNNN`".
   Merging is the product owner's call.

Interrupted runs: every delegation prompt tells the agent to checkpoint (commit, push and log as it goes,
see *Checkpoints and interrupted runs* in `CLAUDE.md`). If an agent stops without its final report (usage limit,
API error), do not restart the step: run `node tools/save-wip.mjs <worktree> --item BL-NNNN --role <role>`, read
the item's *Log* and the branch's commits, then send the same agent a message to continue (or start a new agent of
the same role told to continue from the Log and the commits). After every agent run the worktree must be clean and
pushed before the next step starts. Count resumed and failed runs in the **Cost** line.

Parallel runs: if the product owner asked for several items at once, follow "Parallel delivery" in
CLAUDE.md: every agent for an item works in that item's own worktree, branched from `origin/main`.
