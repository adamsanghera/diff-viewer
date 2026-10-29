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

// Changes inside these never change a diff or a stack. Git's fsmonitor daemon
// writes cookie files on every git command, including diffview's own reads,
// so watching them would make every read look like an edit.
const IGNORED = /(^|[/\\])(node_modules|\.git[/\\]objects|\.git[/\\]logs|fsmonitor--daemon)([/\\]|$)/;

/** Whether a changed path, relative to a watched folder, cannot change a diff or a stack. */
export function ignoredPath(file) {
  return IGNORED.test(file);
}
const QUIET_MS = 300;

/**
 * Calls `onChange` once per burst of changes under the worktree or the git
 * common dir, QUIET_MS after the burst ends, and `onEvent` at once for each
 * change in the burst. Returns a function that stops watching.
 */
export function watchRepo(repo, onChange, onEvent = () => {}) {
  let timer = null;
  const poke = (_event, file) => {
    if (file && ignoredPath(file)) return;
    onEvent();
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

/**
 * Calls `onChange` once per burst of changes to the files given to `add`,
 * QUIET_MS after it ends. It watches each file's folder, not the file:
 * editors often save by renaming a new file over the old one, which ends a
 * watch on the file itself. Returns {add(file), stop()}.
 */
export function watchFiles(onChange) {
  const folders = new Map();
  let timer = null;
  const add = (file) => {
    const dir = path.dirname(file);
    let folder = folders.get(dir);
    if (!folder) {
      folder = { names: new Set(), watcher: null };
      const names = folder.names;
      try {
        folder.watcher = fs.watch(dir, (_event, changed) => {
          if (changed && !names.has(String(changed))) return;
          clearTimeout(timer);
          timer = setTimeout(onChange, QUIET_MS);
        });
      } catch {
        // A folder that does not exist yet has nothing to watch; the next add tries again.
        return;
      }
      folder.watcher.on("error", () => {});
      folders.set(dir, folder);
    }
    folder.names.add(path.basename(file));
  };
  return {
    add,
    stop() {
      clearTimeout(timer);
      for (const { watcher } of folders.values()) watcher.close();
    },
  };
}
