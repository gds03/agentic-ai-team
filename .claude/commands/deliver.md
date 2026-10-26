---
description: Run the full team pipeline for one backlog item (design → implement → review → QA → PR)
argument-hint: BL-NNNN
---

Deliver backlog item **$ARGUMENTS** end to end. You are the orchestrator (acting as scrum
master). Do not do the specialists' work yourself; delegate each step to the named
subagent with the Agent tool, passing the item file path and the previous step's summary.

1. Find the item file in `docs/backlog/` for $ARGUMENTS (match on the ID prefix, `docs/backlog/BL-NNNN-*.md`, since filenames carry a
   KIND tag). Check its `depends_on` items are
   `done`. If not, stop and report what it is waiting on.
2. If `status` is `idea`: run the **architect** agent. If it leaves open questions
   (`blocked: true`), stop and report the questions.
3. Run the **developer** agent to implement and open the PR.
4. Run the **reviewer** agent. If changes are requested, send the findings to the
   **developer**, then review again. Stop after 2 rounds and report if still not approved.
5. Run the **qa** agent. If anything fails, send the report to the **developer**, then
   back through **reviewer** and **qa** (again max 2 rounds).
6. Report: final status, PR link, the QA result per acceptance criterion, any new items or
   open questions created. Merging is the product owner's call.
