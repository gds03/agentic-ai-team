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
5. **Give the test script.** Write it for a non-developer, from the acceptance criteria and the
   QA evidence, in this shape and nothing longer than it needs to be:
   - where to go (app URL, mail catcher URL) and any setup (which accounts or data to create
     first; reuse what earlier items built);
   - numbered steps, each one action and the **expected result**, happy path first, then edge
     cases, each tagged with the criterion it covers (`criterion 3`);
   - states that are hard to reach in the UI (expired, rate limited, failure of an external
     service) with the exact SQL or command to produce them;
   - what cannot be tested by hand yet because a later item builds it, and any known
     deviation the product owner has not accepted yet (name it so they can decide);
   - a closing line asking them to report anything that surprises them.
6. **Say how to finish:** the app stops when they say so (stop it, then confirm nothing listens
   on the port); the worktree you created is removed with `git worktree remove` only when they
   ask. Do not merge; merging is the product owner's call.

If the item has no UI or runtime behaviour (docs, ADR, research), say so and give a short
checklist of what to read instead of launching anything.
