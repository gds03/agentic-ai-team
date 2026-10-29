---
description: Run the full team pipeline for one backlog item (design → implement → review → QA → PR)
argument-hint: BL-NNNN
---

Deliver backlog item **$ARGUMENTS** end to end. You are the orchestrator (acting as scrum
master). Do not do the specialists' work yourself; delegate each step to the named
subagent with the Agent tool, passing the item file path and the previous step's summary.

0. **Confirm before starting.** Do not delegate to any agent yet. Read the item, its spec
   and `docs/PLAN.md`, then show the product owner a short pre-flight summary: the item
   (ID, kind, title), its goal and acceptance criteria, dependency status, open questions,
   what the pipeline will do and which files or areas it will touch, and anything that
   looks off (empty plan, vague criteria, conflicting items, unaccepted ADRs). Then ask
   whether to proceed, adjust the item first, or review the overall direction instead.
   Include the item's **QA tier** (`qa:` field, see `docs/backlog/README.md`) with a one-line
   reason, and let the product owner change it. If the field is empty, propose one. Start
   step 1 only after an explicit yes. Approval covers this item only; ask again next time.
1. Find the item file in `docs/backlog/` for $ARGUMENTS (match on the ID prefix, `docs/backlog/BL-NNNN-*.md`, since filenames carry a
   KIND tag). Check its `depends_on` items are
   `done`. If not, stop and report what it is waiting on.
2. If `status` is `idea`: run the **architect** agent. If it leaves open questions
   (`blocked: true`), stop and report the questions.
3. Run the **developer** agent to implement and open the PR.
4. Run the **reviewer** agent. If changes are requested, send the findings to the
   **developer**, then review again. Stop after 2 rounds and report if still not approved.
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
6. Report: final status, PR link, the QA result per acceptance criterion (and the QA tier
   used), any new items or open questions created. Merging is the product owner's call.

Parallel runs: if the product owner asked for several items at once, follow "Parallel delivery" in
CLAUDE.md: every agent for an item works in that item's own worktree, branched from `origin/main`.
