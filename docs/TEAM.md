# Driving the team day to day

You are the product owner. Your job is ideas, priorities and decisions; the agents do the
design, code, review and testing. The rules they follow are in [`CLAUDE.md`](../CLAUDE.md).

## The loop

1. **Plan** — keep [`PLAN.md`](PLAN.md) current. It is what the scrum master grooms from.
2. **Groom** — `/groom` turns the plan into backlog items in `docs/backlog/` and has the
   architect design the top few. You answer their *Open questions* and accept or reject
   proposed ADRs.
3. **Deliver** — `/deliver BL-NNNN` runs architect → developer → reviewer → QA for one item
   and ends with a PR. Run several at once for items that don't depend on each other.
4. **Research** — while delivery runs, ask `/research <question>` or just think out loud in
   a research session. Notes land in `docs/research/`; good ideas become backlog items.
5. **Check in** — `/status` shows what is done, in flight, blocked on you, and ready next.
   For a visual board and the week's report, run `node tools/board.mjs --open` (kanban by
   status, done/created this week, blocked on you, stale items, epic progress, activity feed).
   `--week 2026-10-19` reports on an earlier week. It reads the backlog files and the *Log*
   timestamps, writes `.board/index.html` (not committed), and needs only Node 18+.
   To *read* the documents themselves, run `node tools/docs.mjs --open`: a viewer with one
   dropdown each for backlog, specs, ADRs and research (plus other docs). New and edited
   files appear on their own, and links between `.md` files open inside the viewer.
6. **Merge** — review the PR summary and QA report, then merge.

## In the Claude project (parallel threads)

Each thread is an independent session with its own branch, so you get real parallelism:

| Thread | Ask the project chat for… | Example |
|---|---|---|
| Delivery | "Start a thread to deliver BL-0004" | runs `/deliver BL-0004`, opens a PR |
| Design | "Start a thread to design the payments area" | architect writes spec + items |
| Research | "Start a research thread: which calendar sync API?" | researcher writes a note |
| Status | Ask in the project chat: "status?" | scrum master summary |

Guidelines:

- **One item per delivery thread.** Start a thread only for items whose `depends_on` are
  done; `/status` lists them under *Ready to start now* and *Can run in parallel*.
- **Contracts unblock parallel work.** If two items need each other's API or schema, ask the
  architect to define the contract first; then both can be delivered at once.
- **Answer questions where they're asked.** A blocked thread waits for you; everything else
  keeps going.
- **Research threads don't touch code,** so they never conflict with delivery threads.

## Locally in Claude Code

The same commands work in a terminal session in this repo (`claude`, then `/status`,
`/deliver BL-0003`, …). For parallel local work, use one git worktree per item, e.g.
`git worktree add ../shop-bl-0003 -b bl-0003-slug` and start `claude` there.

## Where to look

| What | Where |
|---|---|
| What we are building | `docs/PLAN.md` |
| Work items and their history | `docs/backlog/` (each item's *Log*) |
| How a feature works | `docs/specs/` |
| Why we chose X | `docs/adr/` |
| What we learned | `docs/research/` |
