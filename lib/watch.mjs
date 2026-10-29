/**
 * Tells a listener when what a repo's stacks show may have changed: a
 * branch moved (a commit, a rebase, a checkout) or a stacking tool rewrote
 * its records. diffview shows only commits, so edits in the working tree
 * change nothing it shows, and only the git common dir is watched: refs,
 * every worktree's HEAD, config, and the stacking tools' records live there.
 *
 * It listens to filesystem events instead of polling git, which on a large
 * monorepo is too slow to run every second.
 */
import fs from "node:fs";
import path from "node:path";

// Changes inside these, relative to the common dir, never change a diff or a
// stack. Git's fsmonitor daemon writes cookie files on every git command,
// including diffview's own reads, so watching them would make every read
// look like a change.
const IGNORED = /(^|[/\\])(objects|logs|fsmonitor--daemon)([/\\]|$)/;

/** Whether a changed path, relative to the common dir, cannot change a diff or a stack. */
export function ignoredPath(file) {
  return IGNORED.test(file);
}
const QUIET_MS = 300;

/** Calls `onChange` once per burst of changes in the git common dir, QUIET_MS after the burst ends. Returns a function that stops watching. */
export function watchRepo(repo, onChange) {
  let timer = null;
  const watcher = fs.watch(repo.commonDir, { recursive: true }, (_event, file) => {
    if (file && ignoredPath(file)) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, QUIET_MS);
  });
  watcher.on("error", () => {});
  return () => {
    clearTimeout(timer);
    watcher.close();
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
