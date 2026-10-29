---
description: QA verifies a backlog item against its acceptance criteria
argument-hint: BL-NNNN (or "regression" for a full pass)
---

Run the **qa** agent on: $ARGUMENTS. This is an explicit full QA run: it ignores the item's
`qa` tier (use it to force QA on a `skip` or `light` item, or for a regression pass). Report pass/fail per acceptance criterion with
evidence, and any bug items created.
