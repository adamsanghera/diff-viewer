# diffview

A local viewer for stacked branches. Point it at a repo, and it opens a browser tab with:

- the stack the checked-out branch belongs to, from trunk to the top, whichever tool made it: Graphite (`gt`), Origin (`origin stack`), GitHub's `gh stack`, or plain git branches
- each branch's own diff against its parent, the same diff its PR shows, split or unified, highlighted by Pierre's [`@pierre/diffs`](https://diffs.com)
- uncommitted and untracked changes on the checked-out branch
- live reload: commit, rebase, or edit a file, and the page follows
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
| `[` `]` | the branch below or above in the stack |
| `j` `k` | the next or previous file |
| `s` | Auto, Split, or Unified: Auto splits when the pane is wide enough |
| `i` | threads in the margin, or inline under their lines |
| `f` | show or hide the stack and file list |
| `/` | filter files |

When a branch is recorded by several stacking tools, the one that touched it last wins: a rebase by one tool leaves the others' recorded bases out of the branch's history, and among records still valid, the base nearest the tip is the latest. Branches no tool records are placed by their git history. The header names where the stack came from.

## Comments for agents

Click a line number to comment on that line (shift-click or drag for a range), or use a file header's **Comment** for the whole file. Threads float in the margin beside their lines, tinted by whose turn it is, and the agent answers from a terminal in the repo:

```bash
diffview comments list --waiting-on agent --full   # everything in this stack waiting on the agent, in full
diffview comments show 12 15                       # threads in full, with the lines around them
diffview comments reply 12 -m "Which helper should this use?"
diffview comments suggest-resolve 12 -m "Moved it into compute()."
echo '[{"reply": 12, "message": "..."}, {"suggestResolve": 15, "message": "..."}]' | diffview comments apply --stdin
diffview comments wait                             # returns the moment anything here waits on the agent
```

Agents reply and suggest that a thread is resolved. Only you resolve or reopen one, in the page, or with `--human` in a terminal. **Start batch** (or Alt+Enter) holds comments as pending, invisible to agents, until **Send**, so an agent wakes once. Live reload waits while you write a comment, so lines never move under it.

A comment follows its lines' text, not their numbers, so a rebase that moves them keeps it in place. When the lines themselves change, as when an agent edits them, the thread goes outdated: it leaves the margin for the list (the speech-bubble button), says what the lines now read, and links to the version it was made on. The version chip (`v3`) lists every version of a branch's diff that comments were made on.

Mark a file **Viewed** to collapse it. When its diff changes, the mark clears and it shows **Changed since viewed**.

Comments live in `~/.diffview/diffview.sqlite3` (set `DIFFVIEW_HOME` to move it), keyed by each repo's git common dir and branch name, so every worktree of a repo shares them. Deleting is permanent and only in the page. [`skills/diffview-comments/SKILL.md`](skills/diffview-comments/SKILL.md) teaches an agent this loop. Copy it into your agent's skills folder.

## Safety

diffview never writes your repo: it runs read-only git commands and reads stacking tools' records directly. It listens on 127.0.0.1 only, refuses requests that name any other host, and accepts comment writes only from its own page (they need its Origin and a JSON body). The page's Content-Security-Policy runs only diffview's own scripts, and diffs are rendered as text.

## Development

```bash
npm test               # everything; the browser tests drive headless Chrome and skip without it
npm run test:browser   # just the browser tests
DIFFVIEW_TRACE=1 diffview   # log every git call and how long it took
```

The page is plain ES modules under `public/js/`, with no build step of its own; only Pierre's renderer is bundled. Changes under `public/` show on reload, and changes under `lib/` need the viewer restarted. Browser tests look for Chrome at its macOS path, or at `DIFFVIEW_CHROME`.
