---
name: diffview-comments
description: Hand a stack of branches to a human for review in diffview (start the viewer, give them its link), read and answer the comments they leave on a branch's diff or description, and keep each branch's PR description in a linked Markdown file, using the `diffview`, `diffview comments` and `diffview describe` CLIs. Use when a stack is ready for review, when asked to address, answer, or work through review comments or feedback on a branch, PR or stack reviewed locally, when authoring a stack the human reviews in diffview, when the user mentions diffview, or says "check my comments on <branch>".
---

# diffview comments

The human reviews a stack of branches in diffview and comments on lines of
each branch's diff. The comments live in a local SQLite store
(`~/.diffview`), never in the repo. Read and answer them with
`diffview comments`, and change the code with your usual tools. If
`diffview` is not on PATH, run `node ~/code/diff-viewer/bin/diffview.mjs
comments ...` instead.

Run it from inside the repo. Its scope is the stack of the branch checked
out there, so it needs no arguments. `--branch <name>` narrows it to one
branch (repeatable), `--repo` widens it to every commented branch, and
`-C <path>` points at another checkout.

## Handing a stack to review

When a stack is ready for the human to review:

1. Write and link each branch's description file, and the stack's (see
   Descriptions below).
2. From the repo, with the stack's top branch checked out, run
   `diffview review` in a background shell. It lists anything still
   missing a description, starts a viewer for this checkout (or reuses the
   one running), prints a link to the stack's Overview, and then waits for
   comments (4h by default).
3. Give the human the link as soon as it prints.
4. When comments arrive, `review` prints them in full and exits; work
   through them (the loop below), then run `diffview review --after <n>`
   again, with the `--after` it printed last, to hand the stack back.

## The loop

1. `diffview comments list --waiting-on agent --full` prints every thread
   waiting on you, in full: the branch, where it sits, the lines around
   it, and every message. It covers the whole stack in one call, so there
   is no need to loop.
2. Change the code for each thread, or decide not to and say why. A thread
   names its branch. When that is not the branch checked out, move to it
   with the stack's own tool and restack what sits above it: `show` ends
   with the commands for the tool that made the stack (Graphite, Origin,
   `gh stack`, or plain git).
3. Answer each thread:
   - `diffview comments reply <id> -m "..."` to explain or to ask.
   - `diffview comments suggest-resolve <id> -m "<what changed>"` when it
     is done. The human confirms by resolving it.
   - Several at once: `diffview comments apply --from actions.json` with a
     JSON list, applied all or nothing:
     `[{"reply": 7, "message": "..."}, {"suggestResolve": 8, "message": "..."}]`

   For anything longer than a line, or with code blocks, write the message
   to a file outside the worktree and pass `--from <file>` instead of `-m`,
   so you can edit it before sending; `--from -` reads stdin.
4. Run `diffview comments list` again and check each thread's state.

`diffview comments show <id>...` prints chosen threads in full.

Never resolve or reopen a thread. Both belong to the human, and the CLI
refuses them without `--human`, a flag that is not for you.

## Descriptions

Each branch in a stack has a description: a Markdown file you keep and edit
with your usual tools. diffview shows it above the branch's diff, the human
comments on it like the code, and it becomes the PR's body. diffview only
remembers where the file is, and reloads the page when it changes.

Keep description files outside the worktree, or in a gitignored folder in
it (such as the repo's scratch folder for the feature). An untracked file in
the worktree shows up in the checked-out branch's diff, and `describe`
warns when you link one. The PR title goes in front matter:

```markdown
---
title: Share compute() between the two callers
---
## Why
...
## How
...
## Testing
...
```

When you author a branch, write its file and link it once:

```bash
diffview describe --branch <b> path/to/<b>.md     # link it
diffview describe --branch <b>                    # read it back, as the file reads now
gh pr create --title "$(diffview describe --print-title)" --body "$(diffview describe --print)"
```

After that, change the description by editing the file; there is nothing
to re-run. A thread on it names its section and paragraph, and `show` ends
with the file's path. Answer it by editing the file (or replying to say why
not), then suggest resolving it.

The stack has a description too, shown on its Overview page above a list of
its branches: what the stack is for and how its branches fit together.
Write one when you author a stack of more than one branch, and link it from
any branch in the stack:

```bash
diffview describe --stack path/to/stack.md
```

It belongs to the stack's branches, so it follows the stack as you add
branches on top or the bottom ones merge. Threads on it say `the stack
description under "..."` or `the whole stack`.

## Where a thread sits

- `src/app.js lines 40-42`: on those lines of the diff as it reads now.
  `(old side)` means the lines the branch removed.
- `from v3, lines unchanged`: made on an earlier version of the diff, and
  its lines still read the same, so it applies as written.
- `outdated: made on v3, its lines changed since`: the lines it was on
  have changed, usually because someone edited them. `show` prints them as
  they were and what they now read. Check whether that change already
  answers the comment before editing again.
- `the whole file ...` and `the whole branch` have no lines.
- `the description under "How"`: on the branch's description, in that
  section. `from description v2, unchanged` and `outdated: made on
  description v2, its paragraph changed since` work as for lines; v2 is
  the second version of the file someone commented on.

## Also

- Your messages are signed with the start of your session id ("agent
  940d8cee"), so the human can tell agents apart; set
  `DIFFVIEW_AUTHOR=<name>` for a friendlier name.
- Every verb takes `--json` for structured output.
- After a large change, leave notes on your own diff for the human to read
  in review: `diffview comments add --file <path> --line <n>[-<m>] -m "..."`,
  `--file <path>` alone for a whole file, or `--whole-branch`. Say why, not
  what: the diff already shows what.
- `diffview comments wait` (which `review` runs) returns the moment
  anything in scope waits on you, printing those threads in full and a
  last line `Next: diffview comments wait --after <n>` (exit 0), or exits 3
  at its timeout. Without `--after` it returns at once while any thread
  waits on you; with the `--after` it printed, only threads with something
  newer wake it, so a thread you leave waiting on purpose does not. The
  human may batch comments, so one wake can bring several.
