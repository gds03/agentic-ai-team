---
description: Scrum master turns docs/PLAN.md (or a given section) into backlog items
argument-hint: "[plan section or topic, optional]"
---

Run the **scrum-master** agent to groom the backlog from `docs/PLAN.md`.
Scope: $ARGUMENTS (empty means the whole plan; skip items that already exist).

Then run the **architect** agent on the highest-priority items that are not yet designed
(up to 3, independent ones in parallel), so development has designed work queued.
Finish with the `/status` summary.
