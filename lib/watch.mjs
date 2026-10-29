/**
 * Tells a listener when a repo may have changed: a branch moved, a
 * stacking tool rewrote its records, or a file in the working tree changed.
 *
 * It listens to filesystem events instead of polling git. On a large
 * monorepo, finding untracked files takes seconds, which is too slow to run
 * every second but fine once per burst of edits.
 */
import fs from "node:fs";
import path from "node:path";

// Changes inside these never change a diff or a stack.
const IGNORED = /(^|[/\\])(node_modules|\.git[/\\]objects|\.git[/\\]logs)([/\\]|$)/;
const QUIET_MS = 300;

/**
 * Calls `onChange` once per burst of changes under the worktree or the git
 * common dir, QUIET_MS after the burst ends. Returns a function that stops
 * watching.
 */
export function watchRepo(repo, onChange) {
  let timer = null;
  const poke = (_event, file) => {
    if (file && IGNORED.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, QUIET_MS);
  };
  const dirs = [repo.top];
  if (path.relative(repo.top, repo.commonDir).startsWith("..")) dirs.push(repo.commonDir);
  const watchers = dirs.map((dir) => fs.watch(dir, { recursive: true }, poke));
  for (const watcher of watchers) watcher.on("error", () => {});
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
