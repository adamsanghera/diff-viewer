---
name: diffview-comments
description: Read and answer comments a human left on a branch's diff or description in diffview, and write each branch's PR description, using the `diffview comments` and `diffview describe` CLIs. Use when asked to address, answer, or work through review comments or feedback on a branch, PR or stack reviewed locally, when authoring a stack the human reviews in diffview, when the user mentions diffview, or says "check my comments on <branch>".
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
   - Several at once: `diffview comments apply --stdin` with a JSON list,
     applied all or nothing:
     `[{"reply": 7, "message": "..."}, {"suggestResolve": 8, "message": "..."}]`
4. Run `diffview comments list` again and check each thread's state.

`diffview comments show <id>...` prints chosen threads in full.

Never resolve or reopen a thread. Both belong to the human, and the CLI
refuses them without `--human`, a flag that is not for you.

## Descriptions

Each branch in a stack has a description: Markdown that diffview shows
above the branch's diff, that the human comments on like the code, and that
becomes the PR's body. When you author or change a branch, write or update
its description:

```bash
diffview describe --branch <b> --title "Short PR title" --stdin <<'EOF'
## Why
...
## How
...
## Testing
...
EOF
diffview describe --branch <b>                   # read it back
gh pr create --title "$(diffview describe --print-title)" --body "$(diffview describe --print)"
```

Each write keeps a new version. A thread on the description names its
section and paragraph; answer it by rewriting the description (or replying
to say why not), then suggest resolving it.

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
  description v2, its paragraph changed since` work as for lines.

## Also

- Set `DIFFVIEW_AUTHOR=<name>` so the human can tell agents apart.
- Every verb takes `--json` for structured output.
- After a large change, leave notes on your own diff for the human to read
  in review: `diffview comments add --file <path> --line <n>[-<m>] -m "..."`,
  `--file <path>` alone for a whole file, or `--whole-branch`. Say why, not
  what: the diff already shows what.
- `diffview comments wait` returns the moment anything in scope waits on
  you, printing those threads in full (exit 0), or exits 3 at its timeout
  (`--timeout 30m` by default). It has no cursor: answer every thread
  waiting on you before you wait again, or the same threads return at once.
  The human may batch comments, so one wake can bring several.
