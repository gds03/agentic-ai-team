---
description: Launch a backlog item's PR branch and give the product owner a click-by-click script to test it by hand
argument-hint: BL-NNNN (or a PR number)
---

Help the product owner test **$ARGUMENTS** by hand. This is a helper, not a pipeline step: do it
yourself in this session, spawn no agent, change no product code, make no commit, merge nothing.
It works at any point once the item has a branch or PR (in review, in QA or done).

1. **Find the item and its branch.** Match `docs/backlog/BL-NNNN-*.md` (for a PR number, use
   `gh pr view <n> --json headRefName,title`). Read its acceptance criteria, its *Log*
   (QA evidence tells you which edge cases were checked and which gaps remain) and the spec
   sections it cites. Find the branch from the item's `pr:` field or `git branch -a`, and an
   existing worktree for it with `git worktree list`. If there is none and the branch is not
   merged, create one outside the repo: `git worktree add ../<repo>-try-bl-NNNN <branch>`
   (fetch first). If the item is already merged, run from the default branch after `git pull`.
2. **Take the commands from `CLAUDE.md`** (*Tech stack*: prerequisites, build, run, local
   services). Never invent a command; if one is `TBD`, say so and stop instead of guessing. Start
   the local services it names (database, mail catcher, ...) but do not start extra compose
   projects: those belong to QA.
3. **Free the port the app uses.** Check what listens (`netstat -ano`, then the process command
   line). A leftover process of this repo's app: stop it and say so. Anything else: ask first.
4. **Run the app from the item's worktree**, in the background, without a launch profile that
   opens a browser or picks another port. Wait until it answers, then request the route(s) the
   item adds and confirm they exist (a 404 or a missing page means the wrong branch is running).
5. **Seed the data the script needs.** The product owner must never have to build test data by hand.
   Before writing the script, list what each criterion needs to already exist (a staff member for a
   "signed in as staff" step, a service, a booking, an expired token...), check what the local
   database already holds, and **create the missing rows yourself** so the script can start straight
   at the first check. Prefer the app's own routes (sign-up, invite, forms, API calls) so the data is
   realistic; use SQL against the dev database only for what the UI cannot produce. Seed only the
   local dev database, never touch product code, and reuse rows that already exist instead of
   duplicating them. Record in the script a **Seeded data** list: what you created, with the exact
   logins/passwords, names and ids, so each step can say "as staff `staff@example.test`" rather than
   "create a staff member first". If something cannot be seeded (it needs a real external service),
   say so and name the step it affects. `/deliver` writes its first version without launching the app:
   there, write the seed as exact commands/SQL in the script and say they are not run yet; `/try`
   runs them.
6. **Give the test script.** Write it for a non-developer, from the acceptance criteria and the
   QA evidence, in this shape and nothing longer than it needs to be:
   - where to go (app URL, mail catcher URL) and the **Seeded data** list from step 5 (accounts,
     records that already exist); the owner creates nothing before the first step;
   - numbered steps, each one action and the **expected result**, happy path first, then edge
     cases, each tagged with the criterion it covers (`criterion 3`);
   - states that are hard to reach in the UI (expired, rate limited, failure of an external
     service) with the exact SQL or command to produce them;
   - what cannot be tested by hand yet because a later item builds it, and any known
     deviation the product owner has not accepted yet (name it so they can decide);
   - a closing line asking them to report anything that surprises them.
7. **Save the script to the item.** Write the same script into the item file as a collapsed
   section, placed after *Design* and before *Open questions* (replace the block if a previous
   `/try` or `/deliver` left one; `/deliver` writes a first version before QA, so refine it against the
   running build). It must start closed, so never add `open`:

   ```
   <details>
   <summary>Manual test script (from /try)</summary>

   (setup, numbered steps with expected results and criterion tags, hard-to-reach states,
   known gaps: exactly what you gave the product owner)

   </details>
   ```

   Append a *Log* line (`date '+%Y-%m-%d %H:%M'`): `orchestrator: /try wrote the manual test
   script`. This edits only the item's markdown file, in the item's own worktree. Leave it
   uncommitted unless the product owner asks you to commit it. On a merged item, edit it on the
   default branch the same way.
8. **Say how to finish:** the app stops when they say so (stop it, then confirm nothing listens
   on the port); the worktree you created is removed with `git worktree remove` only when they
   ask. Do not merge; merging is the product owner's call.

If the item has no UI or runtime behaviour (docs, ADR, research), say so and give a short
checklist of what to read instead of launching anything.
