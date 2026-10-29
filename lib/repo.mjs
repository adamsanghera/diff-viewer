import fs from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";

/**
 * Finds the git repo holding `dir`: its worktree top, its git dir, the
 * common dir that every worktree shares (where stacking tools keep their
 * records), and the checked-out branch, or null when HEAD is detached.
 */
export async function openRepo(dir) {
  const [top, gitDir, commonDir] = (await git(dir, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"])).trim().split("\n");
  const branch = (await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowExit: [1] })).trim();
  return {
    top,
    gitDir: path.resolve(dir, gitDir),
    commonDir: fs.realpathSync(path.resolve(dir, commonDir)),
    branch: branch || null,
  };
}

/** Local branches: name to {sha, committedAt} (unix seconds of the tip's commit). */
export async function localBranches(repo) {
  const out = await git(repo.top, ["for-each-ref", "refs/heads", "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)"]);
  const heads = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [name, sha, committedAt] = line.split("\0");
    heads.set(name, { sha, committedAt: Number(committedAt) });
  }
  return heads;
}

/** A file's mtime in ms, or null when it does not exist. */
export function mtimeOf(file) {
  return fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
}
