# diffview

A local viewer for stacked branches. Point it at a repo, and it opens a browser tab with:

- the stack the checked-out branch belongs to, from trunk to the top, whichever tool made it: Graphite (`gt`), Origin (`origin stack`), GitHub's `gh stack`, or plain git branches
- each branch's own diff against its parent, the same diff its PR shows, split or unified, highlighted by Pierre's [`@pierre/diffs`](https://diffs.com)
- only what is committed: edits on disk, staged or not, and untracked files never show, so what you review is exactly what the branch holds
- live reload: commit, rebase, or edit a description, and the page follows
- comments on lines, files or whole branches that coding agents read and answer from a terminal

## Setup

```bash
cd ~/code/diff-viewer
npm install
ln -s ~/code/diff-viewer/bin/diffview.mjs ~/.local/bin/diffview   # or npm link
```

The first start bundles Pierre's renderer into `public/vendor/` (under a second; rebuilt whenever `package-lock.json` changes).

## Use

```bash
diffview                         # the stack of the branch checked out here
diffview ~/src/repo -b feature   # another repo, and another branch's stack
diffview --stack-source graphite # read stacks from one tool only
diffview --port 5000 --no-open   # first port to try, and no browser tab
```

| Key | Does |
|---|---|
| `[` `]` | the branch below or above in the stack, with the Overview above the top |
| `j` `k` | the next or previous file |
| `s` | show or hide the stack |
| `i` | threads in the margin, or inline under their lines |
| `v` | mark the whole branch viewed (its own mark, kept until the branch's code changes), or take the mark away |
| `f` | show or hide the branch's files |
| `/` | filter files |

When a branch is recorded by several stacking tools, the one that touched it last wins: a rebase by one tool leaves the others' recorded bases out of the branch's history, and among records still valid, the base nearest the tip is the latest. Branches no tool records are placed by their git history. The header names where the stack came from.

## Comments for agents

An agent hands you a stack with one command, run in the background from the repo:

```bash
diffview review   # lists missing descriptions, starts or reuses a viewer, prints the stack's link, waits for comments
```

Click a line number to comment on that line (shift-click or drag for a range), or use a file header's **Comment** for the whole file. Threads float in the margin beside their lines, tinted by whose turn it is, and the agent answers from a terminal in the repo:

```bash
diffview comments list --waiting-on agent --full   # everything in this stack waiting on the agent, in full
diffview comments show 12 15                       # threads in full, with the lines around them
diffview comments reply 12 -m "Which helper should this use?"
diffview comments suggest-resolve 12 --from why.md # long messages from a file you can edit first
diffview comments apply --from actions.json        # [{"reply": 12, "message": "..."}, {"suggestResolve": 15, "message": "..."}]
diffview comments wait --after 41                  # returns the moment anything newer than message 41 waits on the agent
```

Agents reply and suggest that a thread is resolved. Only you resolve or reopen one, in the page, or with `--human` in a terminal. In a comment or reply box, Enter starts a new line, and Shift+Enter (or ⌘Enter) submits. The button under it says what submitting will do: **Comment** sends at once, **Add to batch** holds it as pending, invisible to agents, until you press **Send batch** at the top right, so an agent wakes once. Its chevron switches between the two, and the choice sticks until you switch back. No key sends the batch. Live reload waits while you write a comment, so lines never move under it.

A comment follows its lines' text, not their numbers, so a rebase that moves them keeps it in place. When the lines themselves change, as when an agent edits them, the thread goes outdated: it leaves the margin for the list (the speech-bubble button), says what the lines now read, and links to the version it was made on. The version chip (`v3`) lists every version of a branch's diff that comments were made on.

### Descriptions

Each branch can carry a description: a Markdown file, usually kept by the agent that built the branch, shown above its diff. As with mdview, the file stays the author's: diffview remembers only where it is, reloads the page when it changes, and keeps a copy of whatever text someone commented on. Select text in it and click **Comment** to leave a thread on that passage; it follows its paragraph through edits the way comments follow lines. The PR title goes in front matter (`title: ...` between `---` lines), and the description is meant to become the PR:

```bash
diffview describe .adam/feature/why-and-how.md   # links the file as the checked-out branch's description
diffview describe                                # prints it as the file reads now
gh pr create --title "$(diffview describe --print-title)" --body "$(diffview describe --print)"
```

Keep description files outside the worktree or in a gitignored folder: an untracked file in the worktree is one `git add -A` away from being committed into the branch, and `describe` warns when you link one.

The stack can carry one too, linked with `diffview describe --stack <file>` from any of its branches: what the stack is for and how its branches fit. The sidebar's **Overview** row shows it above every branch's title, first paragraph and size, and it takes comments like a branch's description. It belongs to the branches it was linked for, so it stays with the stack as branches are added on top or merge from the bottom. No stacking tool has a place for it in a PR, so `--print` hands it to whatever does.

Tests and generated files start hidden and stay out of every count until you turn them on with the **Tests** and **Generated** toggles above the file list. Generated files are the ones `.gitattributes` marks `linguist-generated` or `linguist-vendored`, plus lockfiles, protobuf output, minified bundles and snapshots; tests are marked `diffview-test` or have test-shaped paths. Set an attribute to false (`-linguist-generated`) to override the guess. A file with an open comment always shows.

Checking a file's **Viewed** box collapses it, once; the chevron before its name expands or collapses it whenever you like, and it stays as you leave it. When its diff changes, the mark clears and it shows **Changed since viewed**. Marking a whole branch viewed (`v`) is separate: it marks no file and collapses nothing.

The bars between a file's hunks expand the unmodified lines around them. The file's two versions load the first time you expand one, not before. Comments go only on the diff's own lines, as on GitHub: those are what the branch changes, and what an agent reading the thread sees.

Comments live in `~/.diffview/diffview.sqlite3` (set `DIFFVIEW_HOME` to move it), keyed by each repo's git common dir and branch name, so every worktree of a repo shares them. Deleting is permanent and only in the page. [`skills/diffview-comments/SKILL.md`](skills/diffview-comments/SKILL.md) teaches an agent this loop. Copy it into your agent's skills folder.

## Safety

diffview never writes your repo: it runs read-only git commands and reads stacking tools' records directly. It listens on 127.0.0.1 only, refuses requests that name any other host, and accepts comment writes only from its own page (they need its Origin and a JSON body). The page's Content-Security-Policy runs only diffview's own scripts, and diffs are rendered as text.

## Performance

Three ways to see where time goes:

- **Server-Timing headers.** Every API response says how long its git commands took (summed, so parallel commands can add up to more than the request) and how long the request took. DevTools shows them in the Network panel's Timing tab.
- **`?perf`.** Open `/view?perf` and each load reports, in the console and in `window.diffviewPerf`, every API request with its server and git time, plus the time spent rendering diffs.
- **`DIFFVIEW_TRACE=1`.** The server logs every git command and its duration.

On a large monorepo (hundreds of thousands of remote refs and hundreds of pack files), git dominates. Measured there:

| Load | Time | Where it goes |
|---|---|---|
| A branch that is not checked out, 10 files | 0.45 s to all diffs on screen | 0.17 s for its diff, ~0.2 s rendering |
| A stack, first load | 1.8–2.9 s | merge-bases against a fresh trunk; later loads hit the cache until a branch moves |

The page itself is cheap: one task of about 160 ms while Pierre renders and highlights a few dozen files.

## Development

```bash
npm test               # everything; the browser tests drive headless Chrome and skip without it
npm run test:browser   # just the browser tests
DIFFVIEW_TRACE=1 diffview   # log every git call and how long it took
```

The page is plain ES modules under `public/js/`, with no build step of its own; only Pierre's renderer is bundled. Changes under `public/` show on reload, and changes under `lib/` need the viewer restarted. Browser tests look for Chrome at its macOS path, or at `DIFFVIEW_CHROME`.
